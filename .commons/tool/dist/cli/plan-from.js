// `commons plan-from "<goal>"`: decompose a plain-language goal into tasks grounded in the repository index,
// write them to .commons/tasks.json, and (unless --dry-run) post and plan them exactly like `commons plan`.
// Self-contained on purpose: cli.ts registers this handler, so importing cli.ts here would be a cycle.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoordinatorClient } from "../adapter/client.js";
import { indexRepo } from "../index/symbols.js";
import { tokenizeScopes } from "../index/tokens.js";
import { DEFAULT_MAX_TASKS, decomposeGoal, MIN_TASKS } from "../planning/decompose.js";
import { synthesizeContracts } from "../planning/contracts.js";
const DEFAULT_URL = "http://127.0.0.1:4300"; // same default as cli.ts
const CONFIG_DIR = ".commons";
const CONFIG_FILE = "config.json";
const COMMONS_EXCLUDE = /^\.commons\//;
export const PLAN_FROM_USAGE = `Usage: commons plan-from "<goal>" [--goal-file <path>] [--max-tasks ${DEFAULT_MAX_TASKS}] [--model sonnet]
                        [--out <repo>/${CONFIG_DIR}/tasks.json] [--repo <dir>] [--dry-run] [--no-contracts] [--url <url>] [--token <t>]
`;
const OPTS = {
    repo: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    "goal-file": { type: "string" },
    "max-tasks": { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-contracts": { type: "boolean", default: false },
};
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function usageError(io, message) {
    io.stderr.write(`${message}\n\n${PLAN_FROM_USAGE}`);
    return 2;
}
/** Walk up from `start` to find `.commons/config.json` (same search as `commons plan`). */
function findConfig(start) {
    let current = resolve(start);
    for (;;) {
        const path = join(current, CONFIG_DIR, CONFIG_FILE);
        if (existsSync(path))
            return { root: current, dir: join(current, CONFIG_DIR), config: JSON.parse(readFileSync(path, "utf8")) };
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
function headSync(repo) {
    try {
        return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return "";
    }
}
function renderTable(headers, rows) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n") + "\n";
}
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
function scopeText(scopes) {
    return scopes.map((s) => (s.symbols && s.symbols.length > 0 ? `${s.path}:${s.symbols.join(",")}` : s.path)).join(" ");
}
export function tasksTable(tasks) {
    return renderTable(["id", "title", "writes", "dependsOn"], tasks.map((t) => [t.id ?? "", truncate(t.title, 48), truncate(scopeText(t.writes ?? []), 64), (t.dependsOn ?? []).join(",")]));
}
/**
 * Tokenize scopes for a `privacy: tokens` repo and extend the local token map (`.commons/scopes.json`) so
 * `status` and `report` can render plain paths. Mirrors `commons plan`.
 */
function tokenizeForControlPlane(dir, key, tasks) {
    const mapPath = join(dir, "scopes.json");
    let map = {};
    if (existsSync(mapPath)) {
        try {
            map = JSON.parse(readFileSync(mapPath, "utf8"));
        }
        catch {
            map = {};
        }
    }
    const remember = (scopes) => {
        const tokenized = tokenizeScopes(key, scopes);
        scopes.forEach((plain, i) => {
            const t = tokenized[i];
            map[t.path] = plain.path;
            (plain.symbols ?? []).forEach((sym, j) => {
                map[t.symbols[j]] = sym;
            });
        });
        return tokenized;
    };
    const out = tasks.map((t) => ({ ...t, writes: remember(t.writes ?? []), reads: remember(t.reads ?? []) }));
    writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`);
    return out;
}
export async function planFromCommand(args, io) {
    let values;
    let positionals;
    try {
        ({ values, positionals } = parseArgs({ args, options: OPTS, allowPositionals: true, strict: true }));
    }
    catch (error) {
        return usageError(io, messageOf(error));
    }
    const goalFile = typeof values["goal-file"] === "string" ? values["goal-file"] : undefined;
    let goal = positionals.join(" ").trim();
    if (goalFile) {
        if (goal)
            return usageError(io, "plan-from takes either a goal argument or --goal-file, not both");
        try {
            goal = readFileSync(resolve(goalFile), "utf8").trim();
        }
        catch (error) {
            io.stderr.write(`error: cannot read --goal-file ${goalFile}: ${messageOf(error)}\n`);
            return 1;
        }
    }
    if (!goal)
        return usageError(io, "plan-from requires a goal: a quoted argument or --goal-file <path>");
    const maxTasksArg = typeof values["max-tasks"] === "string" ? values["max-tasks"] : undefined;
    if (maxTasksArg !== undefined && !(/^\d+$/.test(maxTasksArg) && Number(maxTasksArg) >= MIN_TASKS)) {
        return usageError(io, `--max-tasks must be an integer of at least ${MIN_TASKS}`);
    }
    const maxTasks = maxTasksArg === undefined ? DEFAULT_MAX_TASKS : Number(maxTasksArg);
    const dryRun = values["dry-run"] === true;
    const model = typeof values.model === "string" ? values.model : undefined;
    const start = resolve(typeof values.repo === "string" ? values.repo : process.cwd());
    const found = findConfig(start);
    if (!found && !dryRun) {
        io.stderr.write(`error: no ${CONFIG_DIR}/${CONFIG_FILE} found in ${start} or its parents; run \`commons init\` first (or use --dry-run)\n`);
        return 1;
    }
    const root = found?.root ?? start;
    const outPath = typeof values.out === "string" ? resolve(values.out) : join(root, CONFIG_DIR, "tasks.json");
    try {
        const index = indexRepo(root, { commit: headSync(root), exclude: COMMONS_EXCLUDE });
        if (index.files.length === 0)
            throw new Error(`no source files found under ${root}`);
        const decomposed = await decomposeGoal({ goal, index, maxTasks, model, warn: (message) => io.stderr.write(`note: ${message}\n`) });
        const tasks = values["no-contracts"] ? decomposed : synthesizeContracts(decomposed.map((t) => ({ ...t, id: t.id }))).tasks;
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, `${JSON.stringify(tasks, null, 2)}\n`);
        io.stdout.write(tasksTable(tasks));
        io.stdout.write(`Wrote ${tasks.length} tasks to ${outPath}.\n`);
        if (dryRun) {
            io.stdout.write(`Dry run: nothing was posted. Run \`commons plan --tasks ${outPath}\` to plan them.\n`);
            return 0;
        }
        const { dir, config } = found;
        const url = (typeof values.url === "string" ? values.url : undefined) ?? process.env.COMMONS_URL ?? config.url ?? DEFAULT_URL;
        const token = (typeof values.token === "string" ? values.token : undefined) ?? process.env.COMMONS_TOKEN ?? config.token;
        const client = new CoordinatorClient(url, token);
        const inputs = config.privacy === "tokens" ? tokenizeForControlPlane(dir, config.key, tasks) : tasks;
        const added = await client.addTasks(config.repoId, inputs);
        const planned = await client.plan(config.repoId);
        io.stdout.write(`Added ${added.length} task${added.length === 1 ? "" : "s"}; planned ${planned.length} in total.\n`);
        return 0;
    }
    catch (error) {
        io.stderr.write(`error: ${messageOf(error)}\n`);
        return 1;
    }
}
//# sourceMappingURL=plan-from.js.map