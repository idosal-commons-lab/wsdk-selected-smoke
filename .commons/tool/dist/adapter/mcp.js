// MCP adapter (SPEC §9): five tools over JSON-RPC 2.0 on newline-delimited stdio.
//
// One server per task. It is the only platform component that touches the agent's
// worktree, and it only reads it (git status / rev-parse) and pushes from it
// (HEAD -> refs/tasks/<taskId> on the host); it never writes files into it.
// stdout carries JSON-RPC only; diagnostics go to stderr.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { renderBrief } from "../brief/brief.js";
import { taskHints } from "../verify/hints.js";
import { renderDelta } from "../brief/delta.js";
import { openNodeSql } from "../core/sql-node.js";
import { CheckCache, excerptOf, parseFailedTests, renderCommand, runCommand } from "../executor/checks.js";
import { closureIndex } from "../executor/footprint.js";
import { git, gitRaw, mergeTree } from "../executor/git.js";
import { LOCAL_TASK_REF_PREFIX, taskRefFor } from "../executor/task-ref.js";
import { structuredMerge } from "../executor/structured-merge.js";
import { blobsOf, closureKey } from "../executor/verdict-key.js";
import { ClientError } from "./client.js";
import { selfArgv } from "./self.js";
export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_NAME = "commons";
export const MAX_LINE_BYTES = 1024 * 1024;
export const DEFAULT_POLL_MS = 1000;
/**
 * How long `submit` waits for the queue's verdict inside one tool call. Claude Code cuts an MCP tool call at
 * MCP_TOOL_TIMEOUT (five minutes unless raised; the runner raises it to thirty), so the default stays well under
 * that; the verdict also reaches the agent through the hook at its next tool call, or through `status`.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 4 * 60 * 1000;
/** Pre-verification runs the related tests in the agent's worktree; heavy suites take minutes. */
export const DEFAULT_PREVERIFY_TIMEOUT_MS = 30 * 60 * 1000;
export const TOOL_NAMES = ["brief", "claim", "delta", "submit", "status"];
// ---- tool schemas ----------------------------------------------------------
const SCOPE_JSON_SCHEMA = {
    type: "object",
    properties: {
        path: { type: "string", description: "Repository-relative file path." },
        symbols: { type: "array", items: { type: "string" }, description: "Exported symbols within the file (optional)." },
    },
    required: ["path"],
    additionalProperties: false,
};
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
export const TOOL_DEFINITIONS = [
    {
        name: "brief",
        description: "Your task brief: the repository, the test commands, your task text, your write scope, what other agents are working on, the rules, and the exports in your scope. Call this first.",
        inputSchema: EMPTY_SCHEMA,
    },
    {
        name: "claim",
        description: "Declare (replace) the files you will write and read. Returns whether you are admitted or which tasks block you. Call it before touching files outside your scope.",
        inputSchema: {
            type: "object",
            properties: {
                writes: { type: "array", items: SCOPE_JSON_SCHEMA, description: "Files (and optionally symbols) you will change." },
                reads: { type: "array", items: SCOPE_JSON_SCHEMA, description: "Files you depend on but will not change." },
            },
            required: ["writes"],
            additionalProperties: false,
        },
    },
    {
        name: "delta",
        description: "What landed on main since your last call that touches your scope (with contract changes), your bounced submissions, your admission state, and the exact command to update your worktree. Call it before you commit and before you submit.",
        inputSchema: EMPTY_SCHEMA,
    },
    {
        name: "submit",
        description: "Submit the commit at HEAD of your worktree for integration. The platform merges it onto main, runs the tests, and lands it or bounces it. With wait (default true) this blocks until the verdict and returns it together with the current delta.",
        inputSchema: {
            type: "object",
            properties: {
                summary: { type: "string", description: "One-line summary of the change." },
                wait: { type: "boolean", description: "Block until the verdict (default true).", default: true },
                timeoutMs: { type: "integer", minimum: 0, description: "Maximum time to wait for the verdict in milliseconds (default 20 minutes)." },
                force: { type: "boolean", description: "Queue even if the pre-flight dry merge against main conflicts (default false).", default: false },
            },
            required: ["summary"],
            additionalProperties: false,
        },
    },
    {
        name: "status",
        description: "Your task's current status and every submission with its verdict.",
        inputSchema: EMPTY_SCHEMA,
    },
];
const ScopeSchema = z.object({ path: z.string().min(1), symbols: z.array(z.string()).optional() });
const ClaimArgs = z.object({ writes: z.array(ScopeSchema), reads: z.array(ScopeSchema).optional() });
const SubmitArgs = z.object({
    summary: z.string(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    force: z.boolean().optional(),
});
const EmptyArgs = z.object({}).passthrough();
// ---- helpers ---------------------------------------------------------------
function text(body, isError = false) {
    const result = { content: [{ type: "text", text: body }] };
    if (isError)
        result.isError = true;
    return result;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function short(sha) {
    return sha.slice(0, 7);
}
function fence(body) {
    const f = body.includes("```") ? "````" : "```";
    return [f, ...body.replace(/\r\n/g, "\n").trimEnd().split("\n"), f];
}
function list(items, empty = "(none)") {
    return items.length > 0 ? items.map((i) => `- ${i}`) : [`- ${empty}`];
}
function verdictCounts(v) {
    if (!v)
        return "no verdict yet";
    if (v.passed)
        return "passed";
    const parts = [`${v.failedTests.length} failed test${v.failedTests.length === 1 ? "" : "s"}`];
    if (v.conflicts.length > 0)
        parts.push(`${v.conflicts.length} conflict${v.conflicts.length === 1 ? "" : "s"}`);
    return `failed (${parts.join(", ")})`;
}
export function renderStatus(task, submissions) {
    const lines = [
        `# Task ${task.id}: ${task.title}`,
        `Status: ${task.status} (rank ${task.rank}, batch ${task.batch})`,
        `Blocked by: ${task.blockedBy.length > 0 ? task.blockedBy.join(", ") : "(none)"}`,
        `Base commit: ${task.baseCommit}`,
        "Submissions:",
        ...list(submissions.map((s) => `${s.id} [${s.status}] commit ${short(s.commit)}: ${verdictCounts(s.verdict)}${s.summary ? ` — ${s.summary}` : ""}`)),
    ];
    return lines.join("\n") + "\n";
}
export function renderVerdict(submission, toMain, withDelta = true, mainBranch = "main") {
    const lines = [`Submission ${submission.id} (commit ${short(submission.commit)})`];
    const v = submission.verdict;
    if (submission.status === "landed") {
        lines.push("Verdict: landed");
        if (toMain)
            lines.push(`Main is now ${toMain}.`);
        lines.push("Your task is done; do not submit again.");
    }
    else if (submission.status === "bounced") {
        lines.push("Verdict: bounced");
        lines.push("Failed tests:");
        lines.push(...list(v?.failedTests ?? []));
        lines.push("Conflicts:");
        lines.push(...list((v?.conflicts ?? []).map((c) => (c.hunks !== undefined ? `${c.path} (${c.hunks} hunks)` : c.path))));
        const only = v?.onlyFailsCombined ?? [];
        if (only.length > 0) {
            lines.push("Only fails combined with landed work (passes alone):");
            lines.push(...list(only));
        }
        const excerpt = (v?.excerpt ?? "").trim();
        if (excerpt) {
            lines.push("Excerpt:");
            lines.push(...fence(excerpt));
        }
        lines.push(withDelta
            ? "Next: update your worktree (see the delta below), fix, commit, and call submit again."
            : `Next: git fetch origin ${mainBranch} && git rebase origin/${mainBranch}, fix, commit, and call submit again.`);
    }
    else if (submission.status === "superseded") {
        lines.push("Verdict: superseded (a newer submission from this task replaced it).");
    }
    else {
        lines.push(`Verdict: pending (${submission.status})`);
    }
    return lines.join("\n") + "\n";
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/|^[^/\s]+@[^:\s]+:/i;
/** Normalized form of a remote URL or path so equivalent spellings compare equal. */
function canonicalRemote(url) {
    const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
    if (URL_LIKE.test(trimmed))
        return trimmed;
    try {
        return realpathSync(trimmed);
    }
    catch {
        return resolvePath(trimmed);
    }
}
/** The configured remote name that points at `remote`, or null when `remote` is a bare URL/path with no remote. */
export async function resolveRemoteName(worktree, remote) {
    if (/^[A-Za-z0-9_.-]+$/.test(remote)) {
        const named = await gitRaw(worktree, ["remote", "get-url", remote]);
        if (named.code === 0)
            return remote;
    }
    const listed = await gitRaw(worktree, ["remote", "-v"]);
    if (listed.code !== 0)
        return null;
    const want = canonicalRemote(remote);
    for (const line of listed.stdout.split("\n")) {
        const m = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line.trim());
        if (!m)
            continue;
        if (canonicalRemote(m[2]) === want)
            return m[1];
    }
    return null;
}
function packageVersion() {
    try {
        const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
        return pkg.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
// ---- tool runner -----------------------------------------------------------
/** The five tools as plain async functions; `serveMcp` and `commons mcp-call` share it. */
export function createToolRunner(o) {
    const { client, repoId, taskId, worktree } = o;
    const allowed = new Set(o.tools ?? TOOL_NAMES);
    const withDelta = allowed.has("delta");
    const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
    const log = o.log ?? ((line) => process.stderr.write(`${line}\n`));
    const taskRefPrefix = o.taskRefPrefix ?? process.env.COMMONS_TASK_REF_PREFIX ?? LOCAL_TASK_REF_PREFIX;
    const mainBranch = o.mainBranch ?? process.env.COMMONS_MAIN_BRANCH ?? "main";
    const gitOptions = { env: o.gitEnv };
    let cursor = 0;
    let fetched = false;
    let remoteName;
    const resolveRemote = async () => {
        if (remoteName === undefined)
            remoteName = await resolveRemoteName(worktree, o.remote);
        return remoteName;
    };
    const fetchHost = async () => {
        const target = (await resolveRemote()) ?? o.remote;
        const r = await gitRaw(worktree, ["fetch", "--quiet", target], gitOptions);
        if (r.code !== 0)
            log(`[mcp ${taskId}] fetch ${target} failed: ${r.stderr.trim()}`);
    };
    const currentDelta = async () => {
        const [d, status] = await Promise.all([client.delta(repoId, taskId, cursor), client.taskStatus(repoId, taskId)]);
        cursor = Math.max(cursor, d.cursor);
        const name = await resolveRemote();
        return renderDelta(d, status.task, { remote: name ?? "origin", mainBranch });
    };
    const parentMainOf = async () => {
        const name = await resolveRemote();
        if (name) {
            await gitRaw(worktree, ["fetch", "--quiet", name, mainBranch], gitOptions);
            const r = await gitRaw(worktree, ["merge-base", "HEAD", `${name}/${mainBranch}`]);
            if (r.code === 0 && r.stdout.trim())
                return r.stdout.trim();
        }
        else {
            const f = await gitRaw(worktree, ["fetch", "--quiet", o.remote, mainBranch], gitOptions);
            if (f.code === 0) {
                const r = await gitRaw(worktree, ["merge-base", "HEAD", "FETCH_HEAD"]);
                if (r.code === 0 && r.stdout.trim())
                    return r.stdout.trim();
            }
        }
        // A failed fetch cannot establish that the branch contains the coordinator's newest main.
        return (await client.taskStatus(repoId, taskId)).task.baseCommit;
    };
    /**
     * Dry-merge HEAD against the current main before queueing. Returns the conflicting paths when the executor
     * would bounce this commit anyway (textual conflict that neither Mergiraf nor concatenation resolves), so the
     * agent learns it in a second instead of after a queue round trip.
     */
    const preflight = async (head) => {
        if (process.env.COMMONS_LLM_RESOLVE === "1")
            return null; // the executor may still resolve what git cannot
        const name = await resolveRemote();
        let mainRev = null;
        if (name) {
            await gitRaw(worktree, ["fetch", "--quiet", name, mainBranch], gitOptions);
            const r = await gitRaw(worktree, ["rev-parse", `${name}/${mainBranch}`]);
            if (r.code === 0)
                mainRev = r.stdout.trim();
        }
        else {
            const f = await gitRaw(worktree, ["fetch", "--quiet", o.remote, mainBranch], gitOptions);
            if (f.code === 0) {
                const r = await gitRaw(worktree, ["rev-parse", "FETCH_HEAD"]);
                if (r.code === 0)
                    mainRev = r.stdout.trim();
            }
        }
        if (!mainRev)
            return null;
        const baseR = await gitRaw(worktree, ["merge-base", head, mainRev]);
        if (baseR.code !== 0)
            return null;
        const base = baseR.stdout.trim();
        if (base === mainRev)
            return null; // HEAD already contains main
        try {
            const merged = await mergeTree(worktree, base, mainRev, head);
            if (merged.conflicts.length === 0)
                return null;
            const structured = await structuredMerge(worktree, base, mainRev, head, merged.tree, merged.conflicts);
            if (structured)
                return null;
            return { conflicts: merged.conflicts.map((c) => c.path), main: mainRev };
        }
        catch (error) {
            log(`[mcp ${taskId}] preflight skipped: ${messageOf(error)}`);
            return null;
        }
    };
    /** Test runs in flight, by HEAD: a second submit of the same commit joins the first run instead of starting another. */
    const inflight = new Map();
    const openPreverifyCache = () => {
        const sql = openNodeSql(o.preverify?.cachePath ?? ":memory:");
        return { sql, cache: new CheckCache(sql, { client, repoId }) };
    };
    const preverifyPlan = async (head) => {
        const pv = o.preverify;
        if (!pv)
            return null;
        const parentMain = await parentMainOf();
        const baseR = await gitRaw(worktree, ["merge-base", head, parentMain]);
        const base = baseR.code === 0 ? baseR.stdout.trim() : parentMain;
        const changed = (await git(worktree, ["diff", "--name-only", base, head])).split("\n").filter(Boolean);
        if (changed.length === 0)
            return null;
        const tree = await git(worktree, ["rev-parse", `${head}^{tree}`]);
        const blobs = await blobsOf(worktree, tree);
        let index = null;
        try {
            index = closureIndex(worktree);
        }
        catch (error) {
            log(`[mcp ${taskId}] pre-verification index: ${messageOf(error)}`);
        }
        // A closure key only for a file-scoped check: a full-suite verdict depends on the whole tree and keeps the tree key.
        const key = pv.related ? closureKey({ checkId: "related", changedFiles: changed, index, blobs }) : null;
        const { sql, cache } = openPreverifyCache();
        try {
            const known = (key ? await cache.fetch(key, "related") : null) ?? cache.get(tree, "related");
            return { files: changed.length, tree, key, known, command: renderCommand(pv.test, pv.related, changed), timeoutMs: pv.timeoutMs ?? DEFAULT_PREVERIFY_TIMEOUT_MS };
        }
        finally {
            sql.close();
        }
    };
    /** The test run itself, in this process (used when there is no shared cache file for a detached run to write to). */
    const runPreverifyHere = async (plan, started) => {
        const r = await runCommand(["sh", "-c", plan.command], { cwd: worktree, timeoutMs: plan.timeoutMs });
        const passed = !r.timedOut && r.code === 0;
        const excerpt = r.timedOut ? `timeout: pre-verification exceeded ${plan.timeoutMs} ms\n${excerptOf(r.output)}`.trimEnd() : excerptOf(r.output);
        const result = { id: "related", passed, failedTests: passed ? [] : parseFailedTests(r.stdout, r.stderr), excerpt, durationMs: Date.now() - started, cached: false, ...(r.timedOut ? { timedOut: true } : {}) };
        const { sql, cache } = openPreverifyCache();
        try {
            if (plan.key)
                await cache.publish(plan.key, "related", result);
            cache.put(plan.tree, "related", result);
        }
        finally {
            sql.close();
        }
        return result;
    };
    /**
     * The test run in a detached process (`commons preverify-run`) that stores the verdict under the tree and the
     * closure key itself and clears the in-flight mark: a submit-and-stop agent takes this MCP server down with it
     * when it ends its turn, and the verification must outlive both. While this process lives it follows the child
     * and reads the verdict back; when it is gone, the queue finds the verdict in the cache.
     */
    const runPreverifyDetached = async (plan, cachePath, head) => {
        const dir = mkdtempSync(join(tmpdir(), "commons-preverify-"));
        const resultPath = join(dir, "result.json");
        // The verdict is stored for the submitted commit's tree, so the tests must see exactly that tree. A submit-and-stop
        // agent may keep editing its worktree while they run: in the thirteenth run one fixed its bug in the working tree
        // during its pre-verification, which passed and was recorded for the buggy commit, which then landed. The run
        // happens in a copy-on-write snapshot of the worktree reset to the commit (builds and dependencies kept).
        // The snapshot is made by the detached runner itself: a submit-and-stop agent ends its turn right after submit,
        // which takes this server down, and a snapshot made here first (seconds for a large checkout) left the runner
        // unstarted and its in-flight mark standing, so integrators waited half an hour for a verdict (fifteenth run).
        const argv = selfArgv([
            "preverify-run",
            "--cwd", worktree,
            ...(process.env.COMMONS_PREVERIFY_SNAPSHOT === "0" ? [] : ["--snapshot-at", head]),
            "--cache", cachePath,
            "--tree", plan.tree,
            ...(plan.key ? ["--key", plan.key] : []),
            "--timeout-ms", String(plan.timeoutMs),
            "--result", resultPath,
            "--url", client.baseUrl,
            "--repo-id", repoId,
            ...(client.token ? ["--token", client.token] : []),
            "--command", plan.command,
        ]);
        // The runner's own errors (not the tests' output, which it stores in the verdict) go to a log beside the cache.
        const logDir = join(dirname(cachePath), "preverify-logs");
        mkdirSync(logDir, { recursive: true });
        const logFd = openSync(join(logDir, `${taskId}-${plan.tree.slice(0, 8)}-${Date.now()}.log`), "a");
        const code = await new Promise((resolveExit) => {
            const child = spawn(process.execPath, argv, { cwd: worktree, env: process.env, detached: true, stdio: ["ignore", logFd, logFd] });
            child.on("error", () => resolveExit(null));
            child.on("exit", (c) => resolveExit(c));
            child.unref();
        });
        closeSync(logFd);
        try {
            return JSON.parse(readFileSync(resultPath, "utf8"));
        }
        catch (error) {
            throw new Error(`pre-verification runner exited with ${code ?? "an error"} and left no result: ${messageOf(error)}`);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };
    /**
     * The run half, in the background: the tool call returns while the tests run in the worktree, so no call outlives
     * Claude Code's MCP tool timeout however heavy the suite. The verdict is stored under the tree and the closure key
     * (locally and on the control plane) when it completes; the queue reuses a pass and bounces a failure at once.
     */
    const startPreverify = (head, plan) => {
        const running = inflight.get(head);
        if (running)
            return running;
        const cachePath = o.preverify?.cachePath;
        const promise = (async () => {
            const started = Date.now();
            if (plan.key) {
                // Mark the closure as in flight so an integrator on this machine waits for this verdict instead of running the same tests.
                const { sql, cache } = openPreverifyCache();
                try {
                    cache.markRunning(plan.key, "related", started);
                }
                finally {
                    sql.close();
                }
            }
            log(`[mcp ${taskId}] pre-verification${cachePath ? " (detached)" : ""}: ${plan.command}`);
            let result;
            try {
                result = cachePath ? await runPreverifyDetached(plan, cachePath, head) : await runPreverifyHere(plan, started);
            }
            catch (error) {
                // Only an in-process run, or a runner that never produced a verdict, leaves the mark to us.
                if (plan.key) {
                    const { sql, cache } = openPreverifyCache();
                    try {
                        cache.clearRunning(plan.key, "related");
                    }
                    finally {
                        sql.close();
                    }
                }
                throw error;
            }
            log(`[mcp ${taskId}] pre-verification ${result.passed ? "passed" : "failed"} in ${Math.round(result.durationMs / 1000)} s`);
            return result;
        })().finally(() => inflight.delete(head));
        inflight.set(head, promise);
        return promise;
    };
    const landedMain = async (submissionId, since) => {
        let after = since;
        for (let page = 0; page < 20; page++) {
            const events = await client.events(repoId, after, 1000);
            if (events.length === 0)
                break;
            for (const e of events) {
                if (e.type === "landing" && e.submissionId === submissionId) {
                    const payload = e.payload;
                    return payload?.toMain;
                }
                after = Math.max(after, e.seq);
            }
            if (events.length < 1000)
                break;
        }
        return (await client.getRepo(repoId)).mainCommit;
    };
    const tools = {
        async brief(args) {
            EmptyArgs.parse(args ?? {});
            if (!fetched) {
                fetched = true;
                await fetchHost().catch((error) => log(`[mcp ${taskId}] fetch failed: ${messageOf(error)}`));
            }
            const meta = await client.briefMeta(repoId, taskId);
            let index = null;
            try {
                index = o.index?.() ?? null;
            }
            catch (error) {
                log(`[mcp ${taskId}] index failed: ${messageOf(error)}`);
            }
            const exemplarDiffs = {};
            for (const e of meta.exemplars ?? []) {
                const r = await gitRaw(worktree, ["diff", e.fromMain, e.toMain]);
                if (r.code === 0)
                    exemplarDiffs[e.toMain] = r.stdout;
                else
                    log(`[mcp ${taskId}] exemplar diff ${e.toMain.slice(0, 7)} unavailable: ${r.stderr.trim()}`);
            }
            const brief = renderBrief(meta, index, { exemplarDiffs, taskRefPrefix, mainBranch });
            // Coverage-guided "where to look first" (COMMONS_HINTS=1): what the task's words and the base's tests point at.
            const hints = process.env.COMMONS_HINTS === "1" ? taskHints(worktree, meta.task) : "";
            return text(hints ? `${brief.trimEnd()}\n\n${hints}\n` : brief);
        },
        async claim(args) {
            const parsed = ClaimArgs.safeParse(args ?? {});
            if (!parsed.success) {
                return text(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, true);
            }
            const writes = parsed.data.writes;
            const reads = parsed.data.reads ?? [];
            const result = await client.claim(repoId, taskId, { writes, reads });
            const head = result.admitted ? "admitted" : `blocked by ${result.blockedBy.join(", ")}`;
            return text(`${head}\n${result.guidance}\n`);
        },
        async delta(args) {
            EmptyArgs.parse(args ?? {});
            return text(await currentDelta());
        },
        async submit(args) {
            const parsed = SubmitArgs.safeParse(args ?? {});
            if (!parsed.success) {
                return text(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, true);
            }
            const { summary } = parsed.data;
            const wait = parsed.data.wait ?? !o.detach;
            const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
            const dirty = await git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
            if (dirty.trim()) {
                return text(`Refusing to submit: the worktree has uncommitted changes to tracked files:\n${dirty}\nCommit them first (git add -A && git commit -m "<message>"), then call submit again.`, true);
            }
            const head = await git(worktree, ["rev-parse", "HEAD"]);
            const before = await client.taskStatus(repoId, taskId);
            if (head === before.task.baseCommit) {
                return text(`Nothing to submit: HEAD (${short(head)}) is still the task's base commit. Make a commit on your branch first, then call submit again.`, true);
            }
            const previous = before.submissions.find((s) => s.commit === head && s.status !== "superseded");
            if (previous) {
                return text(`Nothing new to submit: HEAD (${short(head)}) was already submitted as ${previous.id} (${previous.status}). Make a new commit with your fix, then call submit again.`, true);
            }
            // Best-of-N (the runner's candidate mode): record the commit for the runner's selection instead of queueing it.
            const candidateFile = o.candidateFile ?? process.env.COMMONS_CANDIDATE_FILE;
            if (candidateFile) {
                mkdirSync(dirname(candidateFile), { recursive: true });
                writeFileSync(candidateFile, JSON.stringify({ commit: head, summary, at: Date.now() }) + "\n");
                return text(`Recorded ${short(head)} as one of several candidate solutions to this task. The platform verifies every candidate and submits the best; you are done for now. Finish with \`SUBMITTED ${head}\`.`);
            }
            if (parsed.data.force !== true) {
                const pf = await preflight(head);
                if (pf) {
                    return text(`Pre-flight: your commit ${short(head)} conflicts with the current main (${short(pf.main)}) in: ${pf.conflicts.join(", ")}.\n` +
                        `It was not queued. Update your branch first: git fetch origin ${mainBranch} && git rebase origin/${mainBranch}, resolve the conflicts, re-run the tests, commit, then call submit again.\n\n` +
                        (withDelta ? await currentDelta() : ""), true);
                }
            }
            let verified = null;
            let background = null;
            if (parsed.data.force !== true && o.preverify) {
                try {
                    const plan = await preverifyPlan(head);
                    if (plan?.known)
                        verified = { result: plan.known, key: plan.key, files: plan.files };
                    else if (plan) {
                        const entry = { files: plan.files, promise: startPreverify(head, plan), settled: null };
                        entry.promise.then((r) => (entry.settled = r)).catch((error) => log(`[mcp ${taskId}] pre-verification failed to run: ${messageOf(error)}`));
                        background = entry;
                    }
                }
                catch (error) {
                    log(`[mcp ${taskId}] pre-verification skipped: ${messageOf(error)}`);
                }
                if (verified && !verified.result.passed) {
                    const failed = verified.result.failedTests;
                    const named = failed.length > 0 ? ` (${failed.length} failing: ${failed.slice(0, 8).join(", ")}${failed.length > 8 ? ", ..." : ""})` : "";
                    return text(`Pre-verification: the related tests fail on your commit ${short(head)}${named}.\n${verified.result.excerpt}\n` +
                        `It was not queued. Fix, run the tests, commit, then call submit again.\n\n` +
                        (withDelta ? await currentDelta() : ""), true);
                }
            }
            const since = cursor;
            await git(worktree, ["push", "--force", "--quiet", o.remote, `HEAD:${taskRefFor(taskRefPrefix, taskId)}`], gitOptions);
            const parentMain = await parentMainOf();
            let submission;
            try {
                submission = await client.submit(repoId, taskId, { commit: head, parentMain, summary });
            }
            catch (error) {
                if (error instanceof ClientError && error.status === 409) {
                    return text(`${error.message}\nWait for the verdict (call ${withDelta ? "status or delta" : "status"}), then submit again.`, true);
                }
                throw error;
            }
            const verifiedNote = verified
                ? `Pre-verified: the related tests for ${verified.files} changed file(s) were already known to pass; the queue reuses that verdict unless something lands inside your change's dependency closure.\n`
                : background
                    ? `Pre-verification of ${background.files} changed file(s) is running in your worktree in the background; the queue reuses its verdict when it passes, and a failure bounces this submission with the failing tests.\n`
                    : "";
            const header = `Submitted ${short(head)} as submission ${submission.id} (status ${submission.status}).\n${verifiedNote}`;
            if (!wait) {
                return text(o.detach
                    ? `${header}Stop now and finish with exactly one line: SUBMITTED ${head}. If this submission bounces, this session is resumed with the verdict.\n`
                    : `${header}Call status to see the verdict, or submit again with wait: true.\n`);
            }
            const deadline = Date.now() + timeoutMs;
            let current = submission;
            let failures = 0;
            for (;;) {
                if (o.signal?.aborted)
                    return text(`${header}Stopped waiting: the session ended.\n`, true);
                try {
                    const now = await client.taskStatus(repoId, taskId);
                    current = now.submissions.find((s) => s.id === submission.id);
                    failures = 0;
                }
                catch (error) {
                    failures += 1;
                    if (failures >= 5)
                        return text(`${header}Lost contact with the coordinator while waiting: ${messageOf(error)}\n`, true);
                }
                if (!current)
                    return text(`${header}The submission disappeared from the coordinator.\n`, true);
                if (current.status === "landed" || current.status === "bounced" || current.status === "superseded")
                    break;
                if (background?.settled && !background.settled.passed) {
                    const failed = background.settled.failedTests;
                    const named = failed.length > 0 ? ` (${failed.length} failing: ${failed.slice(0, 8).join(", ")}${failed.length > 8 ? ", ..." : ""})` : "";
                    return text(`${header}Pre-verification failed on your commit ${short(head)}${named}.\n${background.settled.excerpt}\n` +
                        `The queue will bounce this submission. Fix, run the tests, commit, then call submit again.\n\n` +
                        (withDelta ? await currentDelta() : ""), true);
                }
                if (Date.now() >= deadline) {
                    return text(`${header}Still ${current.status} after ${Math.round(timeoutMs / 1000)} s. The verdict reaches you through the hook at your next tool call, or call status.\n`);
                }
                await sleep(pollMs, o.signal);
            }
            const toMain = current.status === "landed" ? await landedMain(submission.id, since).catch(() => undefined) : undefined;
            const verdict = renderVerdict(current, toMain, withDelta, mainBranch);
            const delta = withDelta ? await currentDelta().catch((error) => `(delta unavailable: ${messageOf(error)})\n`) : "";
            return text(`${header}${verdict}\n${delta}`);
        },
        async status(args) {
            EmptyArgs.parse(args ?? {});
            const s = await client.taskStatus(repoId, taskId);
            return text(renderStatus(s.task, s.submissions));
        },
    };
    return {
        tools: TOOL_DEFINITIONS.filter((t) => allowed.has(t.name)).map((t) => t.name === "submit" && !withDelta ? { ...t, description: t.description.replace(" together with the current delta", "") } : t),
        async call(name, args) {
            const tool = allowed.has(name) ? tools[name] : undefined;
            if (!tool)
                throw new UnknownToolError(name);
            try {
                return await tool(args);
            }
            catch (error) {
                if (error instanceof z.ZodError)
                    return text(`invalid arguments: ${error.issues.map((i) => i.message).join("; ")}`, true);
                return text(messageOf(error), true);
            }
        },
    };
}
export class UnknownToolError extends Error {
    tool;
    constructor(tool) {
        super(`unknown tool: ${tool}`);
        this.tool = tool;
        this.name = "UnknownToolError";
    }
}
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** Split a byte stream into lines, dropping any line longer than `maxBytes`. */
function readLines(stream, maxBytes, onLine, onOverflow) {
    return new Promise((resolve) => {
        let pending = [];
        let pendingBytes = 0;
        let dropping = false;
        const flush = () => {
            if (!dropping && pendingBytes > 0)
                onLine(Buffer.concat(pending).toString("utf8"));
            pending = [];
            pendingBytes = 0;
            dropping = false;
        };
        stream.on("data", (chunk) => {
            let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            for (;;) {
                const nl = buf.indexOf(10);
                if (nl < 0) {
                    if (!dropping) {
                        pending.push(buf);
                        pendingBytes += buf.length;
                        if (pendingBytes > maxBytes) {
                            dropping = true;
                            pending = [];
                            pendingBytes = 0;
                            onOverflow();
                        }
                    }
                    return;
                }
                const head = buf.subarray(0, nl);
                if (!dropping) {
                    pending.push(head);
                    pendingBytes += head.length;
                    if (pendingBytes > maxBytes) {
                        dropping = true;
                        onOverflow();
                    }
                }
                flush();
                buf = buf.subarray(nl + 1);
            }
        });
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            flush();
            resolve();
        };
        stream.on("end", finish);
        stream.on("close", finish);
        stream.on("error", finish);
    });
}
/**
 * Serve the task's tools over JSON-RPC 2.0 on newline-delimited stdio (the framing Claude Code
 * and Codex use for stdio MCP servers). Resolves when stdin ends.
 */
export async function serveMcp(opts) {
    const stdin = opts.stdin ?? process.stdin;
    const stdout = opts.stdout ?? process.stdout;
    const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    const controller = new AbortController();
    if (opts.signal)
        opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const runner = createToolRunner({ ...opts, signal: controller.signal, log });
    const version = packageVersion();
    const write = (message) => {
        try {
            stdout.write(`${JSON.stringify(message)}\n`);
        }
        catch (error) {
            log(`[mcp ${opts.taskId}] stdout write failed: ${messageOf(error)}`);
        }
    };
    const errorResponse = (id, code, message, data) => {
        const response = { jsonrpc: "2.0", id, error: { code, message } };
        if (data !== undefined)
            response.error.data = data;
        return response;
    };
    const handle = async (request) => {
        const id = request.id === undefined ? null : request.id;
        const isNotification = request.id === undefined;
        if (typeof request.method !== "string") {
            return isNotification ? null : errorResponse(id, INVALID_REQUEST, "invalid request: missing method");
        }
        const method = request.method;
        const params = (request.params ?? {});
        try {
            if (method.startsWith("notifications/"))
                return null;
            let result;
            switch (method) {
                case "initialize":
                    result = {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: SERVER_NAME, version },
                        instructions: `Commons task ${opts.taskId}: ${runner.tools.some((t) => t.name === "brief") ? "call brief first, " : ""}${runner.tools.some((t) => t.name === "delta") ? "delta before you commit and before you submit, " : ""}submit with wait: true and act on the verdict.`,
                    };
                    break;
                case "ping":
                    result = {};
                    break;
                case "tools/list":
                    result = { tools: runner.tools };
                    break;
                case "tools/call": {
                    const name = params.name;
                    if (typeof name !== "string")
                        return errorResponse(id, INVALID_PARAMS, "tools/call: missing tool name");
                    try {
                        result = await runner.call(name, params.arguments ?? {});
                    }
                    catch (error) {
                        if (error instanceof UnknownToolError)
                            return errorResponse(id, INVALID_PARAMS, error.message);
                        throw error;
                    }
                    break;
                }
                default:
                    return isNotification ? null : errorResponse(id, METHOD_NOT_FOUND, `method not found: ${method}`);
            }
            return isNotification ? null : { jsonrpc: "2.0", id, result };
        }
        catch (error) {
            log(`[mcp ${opts.taskId}] ${method} failed: ${messageOf(error)}`);
            return isNotification ? null : errorResponse(id, INTERNAL_ERROR, messageOf(error));
        }
    };
    const inflight = new Set();
    const dispatch = (line) => {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            write(errorResponse(null, PARSE_ERROR, "parse error"));
            return;
        }
        const batch = Array.isArray(parsed);
        const requests = (batch ? parsed : [parsed]);
        if (batch && requests.length === 0) {
            write(errorResponse(null, INVALID_REQUEST, "invalid request: empty batch"));
            return;
        }
        const job = (async () => {
            const responses = await Promise.all(requests.map((r) => r && typeof r === "object" ? handle(r) : Promise.resolve(errorResponse(null, INVALID_REQUEST, "invalid request"))));
            const out = responses.filter((r) => r !== null);
            if (batch) {
                if (out.length > 0)
                    write(out);
            }
            else
                for (const r of out)
                    write(r);
        })();
        inflight.add(job);
        void job.finally(() => inflight.delete(job));
    };
    await readLines(stdin, MAX_LINE_BYTES, dispatch, () => {
        write(errorResponse(null, PARSE_ERROR, `line exceeds ${MAX_LINE_BYTES} bytes`));
    });
    controller.abort();
    await Promise.allSettled([...inflight]);
    // Pipes are written asynchronously on macOS: make sure every response reached the OS before
    // the caller exits the process.
    await Promise.race([
        new Promise((resolve) => {
            try {
                stdout.write("", () => resolve());
            }
            catch {
                resolve();
            }
        }),
        sleep(1000),
    ]);
}
//# sourceMappingURL=mcp.js.map