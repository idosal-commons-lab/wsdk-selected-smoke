// The `commons` command line: serve, init, plan, executor, mcp, mcp-call, status, report.
import { adaptCommand, checkCommand } from "./verify/cli.js";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cowCopy } from "./executor/cow.js";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClientError, CoordinatorClient } from "./adapter/client.js";
import { createToolRunner, serveMcp, TOOL_NAMES } from "./adapter/mcp.js";
import { handleHook, readHookState } from "./adapter/hook.js";
import { searchCommand, whyCommand } from "./cli/why.js";
import { planFromCommand } from "./cli/plan-from.js";
import { runSwarm } from "./runner/run.js";
import { renderReport } from "./runner/report.js";
import { openNodeSql } from "./core/sql-node.js";
import { CheckCache, CommandCheck, excerptOf, niced, parseFailedTests, runCommand as runShell } from "./executor/checks.js";
import { runExecutor } from "./executor/executor.js";
import { git, gitEnv } from "./executor/git.js";
import { checkSlotsFromEnv, PRIORITY_INTEGRATION, PRIORITY_PREVERIFY, withCheckSlot } from "./executor/slots.js";
import { ensureWorkClone, hostFor, LocalBareHost } from "./executor/host.js";
import { GitHubHost, withCommitStatuses } from "./executor/github-host.js";
import { LOCAL_TASK_REF_PREFIX } from "./executor/task-ref.js";
import { inferScopes } from "./index/scope.js";
import { indexRepo } from "./index/symbols.js";
import { createRepoKey, tokenizeScopes } from "./index/tokens.js";
import { serve } from "./service/node-server.js";
export const DEFAULT_URL = "http://127.0.0.1:4300";
export const DEFAULT_PORT = 4300;
export const CONFIG_DIR = ".commons";
export const CONFIG_FILE = "config.json";
/** Files the CLI keeps under .commons/; excluded from the symbol index. */
const COMMONS_EXCLUDE = /^\.commons\//;
const USAGE = `commons — coordination layer for parallel coding agents

Usage: commons <command> [options]

Commands:
  serve     [--port ${DEFAULT_PORT}] [--db <path>] [--token <t>]            Run the coordinator (API + dashboard)
  init      [--repo <dir>] [--url <url>] [--name <n>] [--test "<cmd>"]
            [--related "<cmd with {files}>"] [--admission none|dependencies|overlaps|pipeline]
            [--privacy plain|tokens] [--token <t>] [--id <repoId>]
            [--host <git url>]                                          Create .commons/config.json and the bare host (or use
                                                                        the given git URL as the host), register the repo
  adapt     [--ai] [--validate] [--map]                                  Learn how this repository builds, type-checks and tests;
                                                                        write .commons/project.json (see commons adapt --help)
  check     map | plan <files> | related <files> | since [<rev>]          Verification planner: record the base, then check only
                                                                        what a change needs (see commons check --help)
  plan      --tasks <tasks.json> [--repo <dir>]                         Add tasks (inferring scopes) and plan them
  plan-from "<goal>" [--goal-file <path>] [--max-tasks 8] [--model sonnet] [--out <repo>/.commons/tasks.json]
            [--repo <dir>] [--dry-run] [--no-contracts]                   Decompose a goal into scoped tasks with a model, then add and plan them
  executor  [--repo <dir>] [--poll 2000] [--batch 4] [--work <dir>] [--full]
            [--optimistic [--max-risk 0]]                               Merge, test, and land queued submissions (optimistic:
                                                                        land low-risk pre-verified batches first, verify after,
                                                                        revert and bounce what fails)
  mcp       --task <id> [--repo <dir>] [--worktree <dir>] [--remote <url>] [--tools submit,status]
            [--integrate [--batch 4] [--poll 2000]]                     Serve the task's MCP tools on stdio; --integrate also
                                                                        takes the integration role (merge, test, land) in-process
  mcp-call  --task <id> <tool> [--args '<json>'] [--repo <dir>] [--worktree <dir>]
                                                                        Run one tool call and print its text
  run       --tasks <tasks.json> [--agents 4] [--agent claude|codex|fake] [--arm commons|baseline|both]
            [--model <m>] [--out <dir>] [--admission none|dependencies|overlaps|pipeline] [--max-turns N]
            [--timeout-min M] [--max-budget-usd B] [--llm-resolve [model]] [--no-replay] [--preverify] [--detach] [--lean] [--trust-queue] [--window N|auto] [--contracts [minWriters]] [--repo <dir>]
                                                                        Run a swarm (and/or the vanilla-git baseline) and write a report
  hook                                                                  Claude Code hook entry point (reads the hook JSON on stdin)
  abandon   --task <id> [--reason <text>] [--repo <dir>]               Give up on a task and release whatever it blocked
  why       <commit-or-ref> [--repo <dir>] [--remote <url>]           Print why a commit landed: task, verdict, contract changes, brief
  search    <text> [--repo <dir>] [--remote <url>] [--limit 50]       Find landed commits by task id, title, summary, symbol or brief
  status    [--repo <dir>]                                              Print the tasks table and metrics
  report    [--repo <dir>]                                              Print repo, tasks, and metrics as JSON

Every command accepts --url <coordinator url> (default: config url or ${DEFAULT_URL}) and --token <t>
(or COMMONS_TOKEN). --repo defaults to the current directory; the config is found by walking up parents.
`;
// ---- helpers ---------------------------------------------------------------
class UsageError extends Error {
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function parse(args, options, positionals = false) {
    try {
        return parseArgs({ args, options, allowPositionals: positionals, strict: true });
    }
    catch (error) {
        throw new UsageError(messageOf(error));
    }
}
const COMMON_OPTS = {
    repo: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
};
function intOption(value, name, fallback) {
    if (value === undefined)
        return fallback;
    if (!/^\d+$/.test(value))
        throw new UsageError(`--${name} must be a non-negative integer`);
    return Number(value);
}
/** Walk up from `start` to find `.commons/config.json`, like git finds `.git`. */
export function findConfig(start) {
    let current = resolve(start);
    for (;;) {
        const path = join(current, CONFIG_DIR, CONFIG_FILE);
        if (existsSync(path)) {
            const config = JSON.parse(readFileSync(path, "utf8"));
            return { root: current, dir: join(current, CONFIG_DIR), path, config };
        }
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
function requireConfig(repoArg) {
    const start = resolve(repoArg ?? process.cwd());
    const found = findConfig(start);
    if (!found)
        throw new Error(`no ${CONFIG_DIR}/${CONFIG_FILE} found in ${start} or its parents; run \`commons init\` first`);
    return found;
}
function clientFor(config, overrides) {
    const url = overrides.url ?? process.env.COMMONS_URL ?? config.url ?? DEFAULT_URL;
    const token = overrides.token ?? process.env.COMMONS_TOKEN ?? config.token;
    return new CoordinatorClient(url, token);
}
/** `scheme://...` or scp-like `user@host:path`; anything else is treated as a filesystem path. */
function isGitUrl(value) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\\:]+@[^/\\:]+:/.test(value);
}
/** The host URL for a `--remote` value: a configured remote name in the worktree resolves to its URL. */
async function hostUrlOf(worktree, remote) {
    if (remote.includes("/") || remote.includes(":") || existsSync(remote))
        return remote;
    try {
        return await git(worktree, ["remote", "get-url", remote]);
    }
    catch {
        return remote;
    }
}
function headSync(repo) {
    try {
        return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { env: gitEnv(repo), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return "";
    }
}
function scopeText(scopes, plain = (s) => s) {
    return scopes
        .map(plain)
        .map((s) => (s.symbols && s.symbols.length > 0 ? `${s.path}:${s.symbols.join(",")}` : s.path))
        .join(" ");
}
export function renderTable(headers, rows) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n") + "\n";
}
function tasksTable(tasks, plain = (s) => s) {
    const truncate = (s, max = 72) => (s.length <= max ? s : `${s.slice(0, max - 3)}...`);
    return renderTable(["id", "status", "rank", "batch", "blockedBy", "writes"], tasks.map((t) => [t.id, t.status, String(t.rank), String(t.batch), t.blockedBy.join(","), truncate(scopeText(t.writes, plain))]));
}
/** Resolves on SIGINT/SIGTERM; `signal` aborts at the same moment. */
function untilSignal() {
    const controller = new AbortController();
    const done = new Promise((resolve) => {
        const stop = () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            controller.abort();
            resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
    return { signal: controller.signal, done };
}
function loadScopeMap(dir) {
    const path = join(dir, "scopes.json");
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
/** Plain-text view of a tokenized scope using the local token map (unknown tokens are left as is). */
function untokenize(map) {
    return (s) => {
        const out = { path: map[s.path] ?? s.path };
        if (s.symbols)
            out.symbols = s.symbols.map((sym) => map[sym] ?? sym);
        return out;
    };
}
// ---- commands --------------------------------------------------------------
const serveCommand = async (args, io) => {
    const { values } = parse(args, { port: { type: "string" }, db: { type: "string" }, token: { type: "string" }, host: { type: "string" } });
    const port = intOption(values.port, "port", DEFAULT_PORT);
    const found = findConfig(process.cwd());
    const dbPath = values.db ?? join(found?.dir ?? join(process.cwd(), CONFIG_DIR), "coordinator.sqlite");
    const token = values.token ?? process.env.COMMONS_TOKEN;
    const server = await serve({ port, dbPath, token, host: values.host });
    io.stdout.write(`Commons coordinator listening on ${server.url} (db: ${dbPath})\n`);
    const repoHint = found ? `?url=${encodeURIComponent(server.url)}&repo=${encodeURIComponent(found.config.repoId)}${token ? `&token=${encodeURIComponent(token)}` : ""}` : "";
    io.stdout.write(`Dashboard: ${server.url}/${repoHint}\n`);
    const { done } = untilSignal();
    await done;
    await server.close();
    io.stdout.write("Coordinator stopped.\n");
    return 0;
};
const initCommand = async (args, io) => {
    const { values } = parse(args, {
        ...COMMON_OPTS,
        name: { type: "string" },
        test: { type: "string" },
        related: { type: "string" },
        admission: { type: "string" },
        privacy: { type: "string" },
        id: { type: "string" },
        host: { type: "string" },
    });
    const start = resolve(values.repo ?? process.cwd());
    let root;
    try {
        root = await git(start, ["rev-parse", "--show-toplevel"]);
    }
    catch (error) {
        throw new Error(`${start} is not a git repository: ${messageOf(error)}`);
    }
    let head;
    try {
        head = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    }
    catch {
        throw new Error(`${root} has no commits yet; commit something before running commons init`);
    }
    if (values.admission !== undefined && !["none", "dependencies", "overlaps", "pipeline", "declared"].includes(values.admission)) {
        throw new UsageError("--admission must be none, dependencies, overlaps, or pipeline");
    }
    if (values.privacy !== undefined && !["plain", "tokens"].includes(values.privacy)) {
        throw new UsageError("--privacy must be plain or tokens");
    }
    const dir = join(root, CONFIG_DIR);
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, CONFIG_FILE);
    let existing = {};
    if (existsSync(configPath)) {
        try {
            existing = JSON.parse(readFileSync(configPath, "utf8"));
        }
        catch {
            existing = {};
        }
    }
    // The host is the bare repository init manages under .commons/ unless the user points at any git URL
    // (`--host`), in which case nothing is created locally and the URL is stored as is. A managed host
    // recorded by an earlier init at another root (the repository moved) is recreated here.
    const hostPath = join(dir, "host.git");
    const managedHost = (h) => basename(h) === "host.git" && basename(dirname(h)) === CONFIG_DIR;
    const hostArg = values.host === undefined ? undefined : isGitUrl(values.host) ? values.host : resolve(values.host);
    const host = hostArg ?? (existing.host && !managedHost(existing.host) ? existing.host : hostPath);
    const manageHost = host === hostPath;
    const config = {
        repoId: values.id ?? existing.repoId ?? randomUUID(),
        url: values.url ?? existing.url ?? DEFAULT_URL,
        name: values.name ?? existing.name ?? basename(root),
        host,
        key: existing.key ?? createRepoKey(),
        testCommand: values.test ?? existing.testCommand ?? "npm test",
        admission: values.admission ?? existing.admission ?? "overlaps",
        privacy: values.privacy ?? existing.privacy ?? "plain",
        baseCommit: head,
    };
    const related = values.related ?? existing.relatedTestCommand;
    if (related)
        config.relatedTestCommand = related;
    const token = values.token ?? existing.token;
    if (token)
        config.token = token;
    if (!manageHost) {
        const external = hostFor(host);
        const branch = external instanceof GitHubHost ? external.mainBranch : "main";
        const prefix = external instanceof GitHubHost ? external.taskRefPrefix : LOCAL_TASK_REF_PREFIX;
        io.stdout.write(`Host ${host}: external; ${branch} and ${prefix}* live there (push ${branch} at ${head} yourself)\n`);
    }
    else if (existsSync(hostPath)) {
        await git(hostPath, ["fetch", "--quiet", root, "HEAD"]);
        await git(hostPath, ["update-ref", "refs/heads/main", "FETCH_HEAD"]);
        await git(hostPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
        io.stdout.write(`Host ${hostPath}: main set to ${head}\n`);
    }
    else {
        await LocalBareHost.init(hostPath, root, head);
        io.stdout.write(`Host ${hostPath}: created with main at ${head}\n`);
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    io.stdout.write(`Config written to ${configPath}\n`);
    // Keep .commons/ out of the repository without touching its .gitignore.
    try {
        const excludeRel = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
        const excludePath = resolve(root, excludeRel);
        const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
        if (!current.split(/\r?\n/).some((l) => l.trim() === `${CONFIG_DIR}/` || l.trim() === CONFIG_DIR)) {
            mkdirSync(dirname(excludePath), { recursive: true });
            writeFileSync(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${CONFIG_DIR}/\n`);
        }
    }
    catch (error) {
        io.stderr.write(`warning: could not update .git/info/exclude: ${messageOf(error)}\n`);
    }
    const client = clientFor(config, { url: values.url, token: values.token });
    try {
        const repo = await client.createRepo({
            id: config.repoId,
            name: config.name,
            mainCommit: head,
            testCommand: config.testCommand,
            relatedTestCommand: config.relatedTestCommand,
            admission: config.admission,
            privacy: config.privacy,
        });
        io.stdout.write(`Registered repo ${repo.id} (${repo.name}) at ${client.baseUrl}\n`);
    }
    catch (error) {
        if (error instanceof ClientError && error.status === 409) {
            io.stdout.write(`Repo ${config.repoId} is already registered at ${client.baseUrl}\n`);
        }
        else if (error instanceof ClientError) {
            io.stderr.write(`warning: coordinator at ${client.baseUrl} rejected the repo: ${error.message}\n`);
        }
        else {
            io.stderr.write(`warning: coordinator at ${client.baseUrl} is not reachable (${messageOf(error)}); config written. Start it with \`commons serve\` and re-run \`commons init\` to register.\n`);
        }
    }
    return 0;
};
/** Accepts `[...]`, `{tasks: [...]}`, and files where a `tasks` array sits one level deeper. */
export function readTasksFile(path) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const pick = (value) => {
        if (Array.isArray(value))
            return value;
        if (value && typeof value === "object") {
            const tasks = value.tasks;
            if (Array.isArray(tasks))
                return tasks;
        }
        return null;
    };
    let tasks = pick(raw);
    if (!tasks && raw && typeof raw === "object") {
        for (const value of Object.values(raw)) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
                tasks = pick(value);
                if (tasks)
                    break;
            }
        }
    }
    if (!tasks)
        throw new Error(`${path}: expected a JSON array of tasks or an object with a "tasks" array`);
    return tasks;
}
function asScopes(value, where) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`${where}: expected an array of {path, symbols?}`);
    return value.map((s, i) => {
        if (typeof s === "string")
            return { path: s };
        if (!s || typeof s !== "object" || typeof s.path !== "string")
            throw new Error(`${where}[${i}]: expected {path, symbols?}`);
        const scope = { path: s.path };
        const symbols = s.symbols;
        if (Array.isArray(symbols))
            scope.symbols = symbols.map(String);
        return scope;
    });
}
/** Validate raw task records into TaskInput without inferring scopes (the runner infers missing ones). */
function toTaskInputs(raw) {
    return raw.map((t, i) => {
        const where = `tasks[${i}]`;
        if (typeof t.title !== "string")
            throw new Error(`${where}: title is required`);
        const input = { title: t.title, body: typeof t.body === "string" ? t.body : "" };
        if (typeof t.id === "string" && t.id)
            input.id = t.id;
        if (typeof t.kind === "string" && t.kind)
            input.kind = t.kind;
        const writes = asScopes(t.writes, `${where}.writes`);
        const reads = asScopes(t.reads, `${where}.reads`);
        if (writes)
            input.writes = writes;
        if (reads)
            input.reads = reads;
        if (Array.isArray(t.dependsOn))
            input.dependsOn = t.dependsOn.map(String);
        return input;
    });
}
const planCommand = async (args, io) => {
    const { values } = parse(args, { ...COMMON_OPTS, tasks: { type: "string" } });
    if (!values.tasks)
        throw new UsageError("plan requires --tasks <tasks.json>");
    const { root, dir, config } = requireConfig(values.repo);
    const client = clientFor(config, { url: values.url, token: values.token });
    const raw = readTasksFile(resolve(values.tasks));
    const head = headSync(root);
    const index = indexRepo(root, { commit: head, exclude: COMMONS_EXCLUDE });
    const scopeMap = loadScopeMap(dir);
    const tokens = config.privacy === "tokens";
    const remember = (scopes) => {
        if (!tokens)
            return scopes;
        const tokenized = tokenizeScopes(config.key, scopes);
        scopes.forEach((plain, i) => {
            const t = tokenized[i];
            scopeMap[t.path] = plain.path;
            (plain.symbols ?? []).forEach((sym, j) => {
                scopeMap[t.symbols[j]] = sym;
            });
        });
        return tokenized;
    };
    const inputs = raw.map((t, i) => {
        const where = `tasks[${i}]`;
        if (typeof t.title !== "string")
            throw new Error(`${where}: title is required`);
        const body = typeof t.body === "string" ? t.body : "";
        let writes = asScopes(t.writes, `${where}.writes`);
        let reads = asScopes(t.reads, `${where}.reads`);
        if (!writes || !reads) {
            const inferred = inferScopes(index, { title: t.title, body });
            writes ??= inferred.writes;
            const writePaths = new Set(writes.map((w) => w.path));
            reads ??= inferred.reads.filter((r) => !writePaths.has(r.path));
        }
        const input = { title: t.title, body, writes: remember(writes), reads: remember(reads) };
        if (typeof t.id === "string" && t.id)
            input.id = t.id;
        if (typeof t.kind === "string" && t.kind)
            input.kind = t.kind;
        if (Array.isArray(t.dependsOn))
            input.dependsOn = t.dependsOn.map(String);
        return input;
    });
    if (tokens)
        writeFileSync(join(dir, "scopes.json"), `${JSON.stringify(scopeMap, null, 2)}\n`);
    const added = await client.addTasks(config.repoId, inputs);
    const planned = await client.plan(config.repoId);
    const addedIds = new Set(added.map((t) => t.id));
    io.stdout.write(`Added ${added.length} task${added.length === 1 ? "" : "s"}; planned ${planned.length} in total.\n`);
    io.stdout.write(tasksTable(planned, untokenize(scopeMap)));
    const missing = planned.filter((t) => addedIds.has(t.id) && t.writes.length === 0);
    if (missing.length > 0)
        io.stderr.write(`note: no scope could be inferred for ${missing.map((t) => t.id).join(", ")}; they will claim at runtime.\n`);
    return 0;
};
const executorCommand = async (args, io) => {
    const { values } = parse(args, {
        ...COMMON_OPTS,
        poll: { type: "string" },
        batch: { type: "string" },
        work: { type: "string" },
        full: { type: "boolean" },
        id: { type: "string" },
        optimistic: { type: "boolean" },
        "max-risk": { type: "string" },
    });
    const { root, dir, config } = requireConfig(values.repo);
    const client = clientFor(config, { url: values.url, token: values.token });
    const pollMs = intOption(values.poll, "poll", 2000);
    const batchSize = Math.max(1, intOption(values.batch, "batch", 4));
    const work = resolve(values.work ?? join(dir, "work"));
    const host = hostFor(config.host);
    const executorClient = host instanceof GitHubHost && host.token
        ? withCommitStatuses(client, host, (line) => io.stderr.write(`${line}\n`)) : client;
    await ensureWorkClone(work, host);
    const rootModules = join(root, "node_modules");
    const workModules = join(work, "node_modules");
    if (existsSync(rootModules) && !existsSync(workModules)) {
        symlinkSync(rootModules, workModules, "dir");
        io.stdout.write(`Linked ${workModules} -> ${rootModules}\n`);
    }
    const sql = openNodeSql(join(dir, "cache.sqlite"));
    const cache = new CheckCache(sql);
    const checks = [new CommandCheck("related", config.testCommand, { relatedTemplate: config.relatedTestCommand })];
    const landChecks = values.full ? [new CommandCheck("full", config.testCommand)] : [];
    const executorId = values.id ?? `${hostname()}-${process.pid}`;
    io.stdout.write(`Executor ${executorId}: repo ${config.repoId} at ${client.baseUrl}, work ${work}, polling every ${pollMs} ms, batch ${batchSize}${values.full ? ", full suite before landing" : ""}${values.optimistic ? ", optimistic landing" : ""}\n`);
    const optimistic = values.optimistic ? (values["max-risk"] ? { maxRisk: intOption(values["max-risk"], "max-risk", 0) } : true) : undefined;
    const { signal, done } = untilSignal();
    await Promise.all([
        runExecutor({ work, host, checks, landChecks, cache, client: executorClient, repoId: config.repoId, executorId, batchSize, ...(optimistic ? { optimistic } : {}) }, { pollMs, signal }),
        done,
    ]);
    sql.close();
    io.stdout.write("Executor stopped.\n");
    return 0;
};
/** Shared setup for `mcp` and `mcp-call`; SPEC §9's COMMONS_URL / COMMONS_REPO / COMMONS_TASK are honored as fallbacks. */
async function mcpSetup(values) {
    const taskId = values.task ?? process.env.COMMONS_TASK;
    if (!taskId)
        throw new UsageError("--task <id> is required (or set COMMONS_TASK)");
    const worktree = resolve(values.worktree ?? process.env.COMMONS_WORKTREE ?? process.cwd());
    // Config-less mode (used by the runner): coordinator URL, repo id and host come from flags/env.
    const envUrl = values.url ?? process.env.COMMONS_URL;
    const envRepoId = process.env.COMMONS_REPO;
    const envRemote = values.remote ?? process.env.COMMONS_HOST;
    let root;
    let config;
    let configDir;
    if (envUrl && envRepoId && envRemote) {
        root = worktree;
        config = { url: envUrl, repoId: envRepoId, host: envRemote };
    }
    else {
        const found = requireConfig(values.repo);
        root = found.root;
        config = found.config;
        configDir = found.dir;
    }
    const client = clientFor(config, { url: values.url, token: values.token });
    const remote = values.remote ?? process.env.COMMONS_HOST ?? config.host;
    const host = hostFor(await hostUrlOf(worktree, remote));
    const taskRefPrefix = process.env.COMMONS_TASK_REF_PREFIX ?? (host instanceof GitHubHost ? host.taskRefPrefix : LOCAL_TASK_REF_PREFIX);
    const mainBranch = host instanceof GitHubHost ? host.mainBranch : "main";
    let computed = false;
    let cached = null;
    const index = () => {
        if (!computed) {
            computed = true;
            try {
                const exclude = resolve(worktree) === resolve(root) ? COMMONS_EXCLUDE : undefined;
                cached = indexRepo(worktree, { commit: headSync(worktree), exclude });
            }
            catch (error) {
                process.stderr.write(`warning: could not index ${worktree}: ${messageOf(error)}\n`);
                cached = null;
            }
        }
        return cached;
    };
    const repoId = process.env.COMMONS_REPO ?? config.repoId;
    if (!repoId)
        throw new UsageError("no repo id: set COMMONS_REPO or run `commons init`");
    // Pre-verification at submit (the runner sets these for its agents): the related tests run in the worktree
    // and their verdict goes into the shared check cache under its closure-addressed key.
    const env = process.env;
    const preverify = env.COMMONS_PREVERIFY === "1" && env.COMMONS_TEST_COMMAND
        ? {
            test: env.COMMONS_TEST_COMMAND,
            ...(env.COMMONS_RELATED_COMMAND ? { related: env.COMMONS_RELATED_COMMAND } : {}),
            ...(env.COMMONS_CHECK_CACHE ? { cachePath: env.COMMONS_CHECK_CACHE } : {}),
            ...(env.COMMONS_PREVERIFY_TIMEOUT_MS ? { timeoutMs: Number(env.COMMONS_PREVERIFY_TIMEOUT_MS) } : {}),
        }
        : undefined;
    return { client, repoId, taskId, worktree, remote, host, taskRefPrefix, mainBranch, gitEnv: host.gitEnv, index, root, config, configDir, ...(preverify ? { preverify } : {}), ...(env.COMMONS_DETACH === "1" ? { detach: true } : {}) };
}
const MCP_OPTS = { ...COMMON_OPTS, task: { type: "string" }, worktree: { type: "string" }, remote: { type: "string" }, tools: { type: "string" } };
const MCP_SERVE_OPTS = { ...MCP_OPTS, integrate: { type: "boolean" }, batch: { type: "string" }, poll: { type: "string" } };
function toolAllowlist(value) {
    if (value === undefined)
        return undefined;
    const names = value.split(",").map((name) => name.trim());
    if (names.some((name) => !TOOL_NAMES.includes(name))) {
        throw new UsageError(`--tools must be a comma-separated list of ${TOOL_NAMES.join(",")}`);
    }
    return names;
}
/**
 * The integration role, taken by a participant environment next to its MCP server (`commons mcp --integrate`):
 * the same pipeline as `commons executor`, with its own work clone of the host and a check cache beside it.
 * Stops after the current batch once `stop()` is called.
 */
async function startIntegrator(setup, opts) {
    const { client, repoId, taskId, worktree, root, config, configDir } = setup;
    const work = configDir ? join(configDir, "work") : join(dirname(worktree), `.commons-work-${taskId}`);
    const cachePath = configDir ? join(configDir, "cache.sqlite") : `${work}.cache.sqlite`;
    let testCommand = config.testCommand ?? process.env.COMMONS_TEST_COMMAND;
    let relatedTestCommand = config.relatedTestCommand ?? process.env.COMMONS_RELATED_COMMAND;
    if (!testCommand) {
        // Config-less mode without COMMONS_TEST_COMMAND: the coordinator's repo record names the commands.
        const repo = await client.getRepo(repoId);
        testCommand = repo.testCommand;
        relatedTestCommand ??= repo.relatedTestCommand;
    }
    const host = setup.host;
    const executorClient = host instanceof GitHubHost && host.token ? withCommitStatuses(client, host, opts.log) : client;
    await ensureWorkClone(work, host);
    const rootModules = join(root, "node_modules");
    const workModules = join(work, "node_modules");
    if (existsSync(rootModules) && !existsSync(workModules))
        symlinkSync(rootModules, workModules, "dir");
    const sql = openNodeSql(cachePath);
    const cache = new CheckCache(sql, { client, repoId });
    const checks = [new CommandCheck("related", testCommand, { relatedTemplate: relatedTestCommand })];
    const executorId = `${hostname()}-${taskId}`;
    const controller = new AbortController();
    opts.log(`[integrate ${executorId}] repo ${repoId} at ${client.baseUrl}, host ${host.url}, work ${work}, polling every ${opts.pollMs} ms, batch ${opts.batchSize}`);
    const running = runExecutor({ work, host, checks, landChecks: [], cache, client: executorClient, repoId, executorId, batchSize: opts.batchSize }, { pollMs: opts.pollMs, signal: controller.signal });
    return {
        executorId,
        work,
        stop: async () => {
            controller.abort();
            await running;
            sql.close();
        },
    };
}
const mcpCommand = async (args, io) => {
    const { values } = parse(args, MCP_SERVE_OPTS);
    const tools = toolAllowlist(values.tools);
    const setup = await mcpSetup(values);
    const log = (line) => io.stderr.write(`${line}\n`);
    // The server speaks on io (process stdio by default; tests pass streams). A bare async iterable on
    // io.stdin becomes a stream for the line reader; io.stdout only needs `write`.
    const stdin = io.stdin === undefined ? undefined : io.stdin instanceof Readable ? io.stdin : Readable.from(io.stdin);
    const serveOptions = { ...setup, tools, ...(stdin ? { stdin } : {}), stdout: io.stdout, log };
    if (!values.integrate) {
        await serveMcp(serveOptions);
        return 0;
    }
    const integrator = await startIntegrator(setup, {
        batchSize: Math.max(1, intOption(values.batch, "batch", 4)),
        pollMs: intOption(values.poll, "poll", 2000),
        log,
    });
    try {
        await serveMcp(serveOptions);
    }
    finally {
        await integrator.stop();
    }
    return 0;
};
const mcpCallCommand = async (args, io) => {
    const { values, positionals } = parse(args, { ...MCP_OPTS, args: { type: "string" } }, true);
    const tool = positionals[0];
    if (!tool)
        throw new UsageError("mcp-call requires a tool name: brief | claim | delta | submit | status");
    let toolArgs = {};
    if (values.args !== undefined) {
        try {
            toolArgs = JSON.parse(values.args);
        }
        catch (error) {
            throw new UsageError(`--args must be JSON: ${messageOf(error)}`);
        }
    }
    const setup = await mcpSetup(values);
    const runner = createToolRunner({ ...setup, tools: toolAllowlist(values.tools), log: (line) => io.stderr.write(`${line}\n`) });
    const result = await runner.call(tool, toolArgs);
    const text = result.content.map((c) => c.text).join("\n");
    io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return result.isError ? 1 : 0;
};
/**
 * Internal: one pre-verification run, started detached by the MCP submit tool so it outlives the agent's session.
 * Runs the command in the worktree, stores the verdict under the tree and the closure key in the shared check cache
 * (and on the control plane when COMMONS_URL/COMMONS_REPO are set), clears the in-flight mark, writes the result.
 */
const preverifyRunCommand = async (args) => {
    const { values } = parse(args, {
        cwd: { type: "string" },
        cache: { type: "string" },
        tree: { type: "string" },
        key: { type: "string" },
        "timeout-ms": { type: "string" },
        result: { type: "string" },
        command: { type: "string" },
        url: { type: "string" },
        "repo-id": { type: "string" },
        token: { type: "string" },
        "snapshot-at": { type: "string" },
    });
    let cwd = values.cwd ?? process.cwd();
    let snapshot = null;
    if (values["snapshot-at"]) {
        // The verdict is stored for the submitted commit's tree, so the tests must see exactly that tree, not a worktree
        // the agent keeps editing: a copy-on-write snapshot reset to the commit (builds and dependencies kept).
        const target = join(dirname(cwd), `.preverify-${basename(cwd)}-${values["snapshot-at"].slice(0, 8)}-${Date.now().toString(36)}`);
        try {
            await cowCopy(cwd, target);
            await git(target, ["checkout", "--quiet", "--force", "--detach", values["snapshot-at"]]);
            await git(target, ["clean", "-fdq"]);
            snapshot = target;
            cwd = target;
        }
        catch (error) {
            process.stderr.write(`pre-verification snapshot failed (${messageOf(error)}); running in the worktree\n`);
            rmSync(target, { recursive: true, force: true });
        }
    }
    if (!values.cache || !values.tree || !values.command)
        throw new UsageError("preverify-run requires --cache, --tree and --command");
    const command = values.command;
    const timeoutMs = intOption(values["timeout-ms"], "timeout-ms", 30 * 60 * 1000);
    let started = Date.now();
    const sql = openNodeSql(values.cache);
    const url = values.url ?? process.env.COMMONS_URL;
    const repoId = values["repo-id"] ?? process.env.COMMONS_REPO;
    const token = values.token ?? process.env.COMMONS_TOKEN;
    const cache = new CheckCache(sql, url && repoId ? { client: new CoordinatorClient(url, token), repoId } : undefined);
    try {
        // Wait for a machine-wide check slot, behind the integrators' checks (slots.ts); the run, and the in-flight mark
        // integrators wait on, start once one is held. An integrator that did not wait checks the same closure itself, so
        // the verdict may be there by then: it is this run's verdict too.
        const r = await withCheckSlot(checkSlotsFromEnv(), async () => {
            const known = values.key ? await cache.fetch(values.key, "related") : null;
            if (known)
                return known;
            if (values.key)
                cache.markRunning(values.key, "related");
            started = Date.now();
            return runShell(niced(["sh", "-c", command]), { cwd, timeoutMs });
        }, 
        // Promoted to the integrators' priority while an integrator waits for this verdict.
        { priority: () => (values.key && cache.isWanted(values.key, "related") ? PRIORITY_INTEGRATION : PRIORITY_PREVERIFY) });
        if ("id" in r) {
            cache.put(values.tree, "related", r);
            if (values.result)
                writeFileSync(values.result, JSON.stringify(r));
            return 0;
        }
        const passed = !r.timedOut && r.code === 0;
        const excerpt = r.timedOut ? `timeout: pre-verification exceeded ${timeoutMs} ms\n${excerptOf(r.output)}`.trimEnd() : excerptOf(r.output);
        const result = { id: "related", passed, failedTests: passed ? [] : parseFailedTests(r.stdout, r.stderr), excerpt, durationMs: Date.now() - started, cached: false, ...(r.timedOut ? { timedOut: true } : {}) };
        // The shared verdict first: once the tree key is visible, the closure key is too, locally and on the control plane.
        if (values.key)
            await cache.publish(values.key, "related", result);
        cache.put(values.tree, "related", result);
        if (values.result)
            writeFileSync(values.result, JSON.stringify(result));
        return 0;
    }
    finally {
        if (values.key)
            cache.clearRunning(values.key, "related");
        sql.close();
        // The snapshot is deleted by a detached low-priority process, so the verdict is not held up.
        if (snapshot) {
            const child = spawn("nice", ["-n", "15", "rm", "-rf", snapshot], { detached: true, stdio: "ignore" });
            child.on("error", () => undefined);
            child.unref();
        }
    }
};
const abandonCommand = async (args, io) => {
    const { values, positionals } = parse(args, { ...COMMON_OPTS, task: { type: "string" }, reason: { type: "string" } }, true);
    const taskId = values.task ?? positionals[0];
    if (!taskId)
        throw new UsageError("abandon requires --task <id>");
    const { config } = requireConfig(values.repo);
    const client = clientFor(config, { url: values.url, token: values.token });
    const task = await client.abandon(config.repoId, taskId, values.reason ?? "");
    io.stdout.write(`Task ${task.id} is now ${task.status}.\n`);
    return 0;
};
const statusCommand = async (args, io) => {
    const { values } = parse(args, COMMON_OPTS);
    const { dir, config } = requireConfig(values.repo);
    const client = clientFor(config, { url: values.url, token: values.token });
    const [repo, tasks, metrics] = await Promise.all([
        client.getRepo(config.repoId),
        client.listTasks(config.repoId),
        client.metrics(config.repoId),
    ]);
    io.stdout.write(`Repo ${repo.id} (${repo.name}) main ${repo.mainCommit}\n`);
    io.stdout.write(tasksTable(tasks, untokenize(loadScopeMap(dir))));
    io.stdout.write(`Landings ${metrics.landings}, bounces ${metrics.bounces}, conflicts ${metrics.conflicts}, cached verdicts ${metrics.cachedVerdicts}, mean submit->verdict ${metrics.meanSubmitToVerdictMs === null ? "n/a" : `${(metrics.meanSubmitToVerdictMs / 1000).toFixed(1)} s`}\n`);
    return 0;
};
const reportCommand = async (args, io) => {
    const { values } = parse(args, COMMON_OPTS);
    const { config } = requireConfig(values.repo);
    const client = clientFor(config, { url: values.url, token: values.token });
    const [repo, tasks, metrics] = await Promise.all([
        client.getRepo(config.repoId),
        client.listTasks(config.repoId),
        client.metrics(config.repoId),
    ]);
    const submissions = (await Promise.all(tasks.map((t) => client.taskStatus(config.repoId, t.id)))).flatMap((s) => s.submissions);
    io.stdout.write(`${JSON.stringify({ repo, metrics, tasks, submissions }, null, 2)}\n`);
    return 0;
};
const hookCommand = async (_args, io) => {
    const chunks = [];
    for await (const chunk of io.stdin ?? process.stdin)
        chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    let input = {};
    if (raw) {
        try {
            input = JSON.parse(raw);
        }
        catch {
            return 0; // never break the agent because of a malformed hook payload
        }
    }
    // Agents may be launched from a shared directory; the worktree then comes from the environment.
    const cwd = process.env.COMMONS_WORKTREE ?? (typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
    const state = await readHookState(cwd);
    const taskId = process.env.COMMONS_TASK ?? state?.taskId;
    if (!taskId)
        return 0;
    try {
        const setup = await mcpSetup({ task: taskId, worktree: cwd });
        const out = await handleHook(input, { client: setup.client, repoId: setup.repoId, taskId, worktree: cwd, remote: "origin", mainBranch: setup.mainBranch, ...(process.env.COMMONS_DETACH === "1" ? { detach: true } : {}), ...(process.env.COMMONS_CANDIDATE_FILE ? { candidateFile: process.env.COMMONS_CANDIDATE_FILE } : {}) });
        if (out)
            io.stdout.write(JSON.stringify(out) + "\n");
    }
    catch (error) {
        io.stderr.write(`commons hook: ${messageOf(error)}\n`);
    }
    return 0;
};
const RUN_OPTS = {
    ...COMMON_OPTS,
    tasks: { type: "string" },
    agents: { type: "string" },
    agent: { type: "string" },
    arm: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    admission: { type: "string" },
    contracts: { type: "string" },
    "max-turns": { type: "string" },
    "timeout-min": { type: "string" },
    "max-budget-usd": { type: "string" },
    "baseline-first": { type: "boolean" },
    "no-hooks": { type: "boolean" },
    "llm-resolve": { type: "string" },
    "no-replay": { type: "boolean", default: false },
    preverify: { type: "boolean", default: false },
    detach: { type: "boolean", default: false },
    lean: { type: "boolean", default: false },
    "trust-queue": { type: "boolean", default: false },
    window: { type: "string" },
};
const runCommand = async (args, io) => {
    // parseArgs has no optional string values; a bare --contracts uses the default threshold.
    const normalizedArgs = args.map((arg, i) => arg === "--contracts" && (!args[i + 1] || args[i + 1].startsWith("-")) ? "--contracts=3" : arg);
    const { values } = parse(normalizedArgs, RUN_OPTS);
    if (values.contracts !== undefined && (!/^\d+$/.test(values.contracts) || !Number.isSafeInteger(Number(values.contracts)) || Number(values.contracts) < 1)) {
        throw new UsageError("--contracts must be a positive integer");
    }
    if (!values.tasks)
        throw new UsageError("run requires --tasks <tasks.json>");
    const { root, config } = requireConfig(values.repo);
    const tasks = toTaskInputs(readTasksFile(resolve(values.tasks)));
    const agent = (values.agent ?? "claude");
    if (!["claude", "codex", "fake"].includes(agent))
        throw new UsageError("--agent must be claude, codex or fake");
    const armArg = values.arm ?? "commons";
    if (!["commons", "baseline", "both"].includes(armArg))
        throw new UsageError("--arm must be commons, baseline or both");
    const admission = (values.admission ?? config.admission ?? "none");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = resolve(values.out ?? join(root, ".commons", "runs", stamp));
    const arms = armArg === "both" ? (values["baseline-first"] ? ["baseline", "commons"] : ["commons", "baseline"]) : [armArg];
    const nodeModules = existsSync(join(root, "node_modules")) ? join(root, "node_modules") : undefined;
    const reports = [];
    for (const arm of arms) {
        io.stderr.write(`== ${arm} arm: ${tasks.length} tasks, ${values.agents ?? 4} agents (${agent}) -> ${join(out, arm)}\n`);
        const report = await runSwarm({
            repo: root,
            tasks,
            agents: intOption(values.agents, "--agents", 4),
            agent,
            arm,
            out: join(out, arm),
            ...(values.model ? { model: values.model } : {}),
            ...(values["max-turns"] ? { maxTurns: intOption(values["max-turns"], "--max-turns", 0) } : {}),
            ...(values["max-budget-usd"] ? { maxBudgetUsd: Number(values["max-budget-usd"]) } : {}),
            timeoutMs: intOption(values["timeout-min"], "--timeout-min", 30) * 60_000,
            admission,
            ...(values.contracts !== undefined ? { contracts: { minWriters: Number(values.contracts) } } : {}),
            ...(values.window ? { window: values.window === "auto" ? "auto" : Number(values.window) } : {}),
            checks: { test: config.testCommand ?? "npm test", ...(config.relatedTestCommand ? { related: config.relatedTestCommand } : {}) },
            ...(nodeModules ? { nodeModules } : {}),
            repoId: `${config.repoId ?? "repo"}-${arm}-${stamp}`,
            hooks: values["no-hooks"] ? false : true,
            ...(values["llm-resolve"] !== undefined ? { llmResolve: { model: values["llm-resolve"] || "sonnet" } } : {}),
            ...(values["no-replay"] ? { replay: false } : {}),
            ...(values.preverify ? { preverify: true } : {}),
            ...(values.detach ? { detach: true } : {}),
            ...(values.lean ? { lean: true } : {}),
            ...(values["trust-queue"] ? { trustQueue: true } : {}),
            ...(values.url ? { coordinatorUrl: values.url, coordinatorToken: values.token ?? process.env.COMMONS_TOKEN ?? config.token } : {}),
            log: (line) => io.stderr.write(`${line}\n`),
        });
        reports.push(report);
    }
    const summary = renderReport(reports);
    writeFileSync(join(out, "summary.md"), summary);
    io.stdout.write(summary);
    io.stdout.write(`\nReports: ${out}\n`);
    return 0;
};
const COMMANDS = {
    serve: serveCommand,
    init: initCommand,
    plan: planCommand,
    "plan-from": planFromCommand,
    executor: executorCommand,
    mcp: mcpCommand,
    "mcp-call": mcpCallCommand,
    "preverify-run": preverifyRunCommand,
    run: runCommand,
    hook: hookCommand,
    abandon: abandonCommand,
    why: whyCommand,
    search: searchCommand,
    status: statusCommand,
    report: reportCommand,
    check: (args, io) => checkCommand(args, io),
    adapt: (args, io) => adaptCommand(args, io),
};
function version() {
    try {
        return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
/** Entry point used by bin/commons.mjs. Returns the process exit code. */
export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
    const [command, ...rest] = argv;
    if (!command || command === "help" || command === "--help" || command === "-h") {
        io.stdout.write(USAGE);
        return 0;
    }
    if (command === "--version" || command === "-v") {
        io.stdout.write(`commons ${version()}\n`);
        return 0;
    }
    const handler = COMMANDS[command];
    if (!handler) {
        io.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
    if (rest.includes("--help") || rest.includes("-h")) {
        io.stdout.write(USAGE);
        return 0;
    }
    try {
        return await handler(rest, io);
    }
    catch (error) {
        if (error instanceof UsageError) {
            io.stderr.write(`${error.message}\n\n${USAGE}`);
            return 2;
        }
        io.stderr.write(`error: ${messageOf(error)}\n`);
        return 1;
    }
}
// Run when executed directly (`node --import tsx src/cli.ts ...`, `node dist/cli.js ...`).
// bin/commons.mjs imports this module and calls main() itself, so argv[1] differs there.
const invokedDirectly = (() => {
    try {
        return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    }
    catch {
        return false;
    }
})();
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map