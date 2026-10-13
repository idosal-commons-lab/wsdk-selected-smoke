// Goal decomposition: a plain-language goal becomes a validated task list for `commons plan`, grounded in the
// repository index (real paths and exported symbols). The planner model is `claude -p` by default; `command`
// (or COMMONS_DECOMPOSER_CMD) overrides it for tests and other models: the command receives the prompt on stdin
// and must print the JSON task list. Data-plane module: it spawns processes and reads the index, never the
// control plane.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
const run = promisify(execFile);
export const DEFAULT_MAX_TASKS = 8;
export const MIN_TASKS = 2;
const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MS = 300_000;
const DIGEST_MAX_BYTES = 24 * 1024;
const DIGEST_MAX_FILES = 60;
const SIGNATURE_MAX_CHARS = 100;
const EXPORTS_PER_FILE = 40;
const K1 = 1.2;
const B = 0.75;
// ---------------------------------------------------------------------------------------------
// Repository digest: directory outline plus the most relevant files with their exports.
const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with", "from", "into",
    "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those",
    "there", "then", "than", "so", "if", "not", "no", "do", "does", "did", "should", "would", "could", "can",
    "will", "may", "must", "we", "you", "they", "our", "your", "their", "when", "where", "which", "who",
    "what", "how", "all", "any", "each", "also", "via", "use", "used", "using", "add", "adds", "added",
    "make", "makes", "new", "support",
]);
const CAMEL_PART = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
/** Same tokenization as scope inference: split on non-alphanumerics and camelCase, lowercase, keep whole segments. */
function tokenize(text) {
    const out = [];
    for (const segment of text.split(/[^A-Za-z0-9]+/)) {
        if (!segment)
            continue;
        const lower = segment.toLowerCase();
        const parts = segment.match(CAMEL_PART) ?? [];
        if (parts.length > 1) {
            for (const part of parts)
                out.push(part.toLowerCase());
            out.push(lower);
        }
        else
            out.push(lower);
    }
    return out;
}
function count(tokens) {
    const counts = new Map();
    for (const token of tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
}
function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/** Files ordered by BM25 relevance of the goal to path segments and export names, boosted by export count. */
export function rankFiles(index, goal) {
    const docs = index.files.map((file) => {
        const tokens = [...tokenize(file.path), ...file.exports.flatMap((e) => tokenize(e.name))];
        return { file, tf: count(tokens), length: tokens.length };
    });
    const n = docs.length;
    if (n === 0)
        return [];
    const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / n || 1;
    const df = new Map();
    for (const doc of docs)
        for (const term of doc.tf.keys())
            df.set(term, (df.get(term) ?? 0) + 1);
    const idf = (term) => {
        const d = df.get(term) ?? 0;
        return Math.log(1 + (n - d + 0.5) / (d + 0.5));
    };
    const query = count(tokenize(goal).filter((t) => !STOPWORDS.has(t)));
    return docs
        .map((doc) => {
        let score = 0;
        for (const [term, qtf] of query) {
            const tf = doc.tf.get(term) ?? 0;
            if (tf === 0)
                continue;
            const norm = tf + K1 * (1 - B + (B * doc.length) / avgLength);
            score += qtf * idf(term) * ((tf * (K1 + 1)) / norm);
        }
        return { file: doc.file, score: score + 0.5 * Math.log2(1 + doc.file.exports.length) };
    })
        .sort((a, b) => b.score - a.score || b.file.exports.length - a.file.exports.length || cmp(a.file.path, b.file.path))
        .map((r) => r.file);
}
/** `dir/ (n files)` lines to depth 2, children indented under their parent; root files count under `./`. */
function directoryOutline(paths) {
    const counts = new Map();
    for (const path of paths) {
        const dirs = path.split("/").slice(0, -1);
        if (dirs.length === 0) {
            counts.set("./", (counts.get("./") ?? 0) + 1);
            continue;
        }
        for (let depth = 1; depth <= Math.min(dirs.length, 2); depth++) {
            const key = dirs.slice(0, depth).join("/") + "/";
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return [...counts]
        .sort(([a], [b]) => cmp(a, b))
        .map(([dir, n]) => `${"  ".repeat(dir.split("/").length - 2)}${dir} (${n} file${n === 1 ? "" : "s"})`);
}
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
/**
 * Compact repository digest for the planner prompt: directory outline (depth 2), then the top files by
 * relevance and export count with their exports (`name: signature`, signatures cut at 100 chars), then the
 * remaining paths. Capped at about 24 KiB.
 */
export function buildDigest(index, goal, opts = {}) {
    const maxFiles = opts.maxFiles ?? DIGEST_MAX_FILES;
    const budget = (opts.maxBytes ?? DIGEST_MAX_BYTES) - 32; // room for the truncation note
    const ranked = rankFiles(index, goal);
    const detailed = ranked.slice(0, maxFiles);
    const rest = ranked
        .slice(maxFiles)
        .map((f) => f.path)
        .sort(cmp);
    const lines = [];
    let bytes = 0;
    let truncated = false;
    const push = (line) => {
        const size = Buffer.byteLength(line, "utf8") + 1;
        if (bytes + size > budget) {
            truncated = true;
            return false;
        }
        lines.push(line);
        bytes += size;
        return true;
    };
    push(`Directories (${index.files.length} source file${index.files.length === 1 ? "" : "s"}):`);
    for (const line of directoryOutline(index.files.map((f) => f.path)))
        if (!push(line))
            break;
    push("");
    push(`Files (${detailed.length} of ${ranked.length}, most relevant first; exports as name: signature):`);
    outer: for (const file of detailed) {
        if (!push(file.path))
            break;
        const shown = file.exports.slice(0, EXPORTS_PER_FILE);
        for (const e of shown) {
            const signature = truncate(e.signature, SIGNATURE_MAX_CHARS);
            // Functions and typed consts already start with their name (`f(x): T`, `C: string`); classes, interfaces,
            // types, enums and renamed exports do not, so those get a `name: ` prefix the model can copy from.
            const named = signature === e.name || (signature.startsWith(e.name) && /^[(:<]/.test(signature.slice(e.name.length)));
            if (!push(named ? `  ${signature}` : `  ${e.name}: ${signature}`))
                break outer;
        }
        if (file.exports.length > shown.length)
            push(`  ... ${file.exports.length - shown.length} more exports`);
    }
    if (rest.length > 0 && !truncated) {
        push("");
        push("Other files (paths only):");
        for (const path of rest)
            if (!push(path))
                break;
    }
    if (truncated)
        lines.push("... (digest truncated)");
    return lines.join("\n");
}
// ---------------------------------------------------------------------------------------------
// Prompt and output schema
export function buildPrompt(goal, digest, maxTasks) {
    return `You are the planner for Commons, a coordination layer that runs many coding agents in parallel on one repository.

How Commons works:
- Each task goes to exactly one agent. The agent works in its own worktree, sees only its own task (title and body) plus a brief of the repository, and submits one commit. It does not see this goal, the other tasks, or your reasoning.
- Every task lands on main independently and is tested on its own, so each task must leave the repository building and passing its tests without the others.
- "dependsOn" orders landings: it lists the ids of the tasks whose landed changes this task builds on (producer before consumer). Tasks without dependencies run and land in parallel.
- Scopes: "writes" are the files and the exported symbols a task will add or change; "reads" are the files it relies on without changing. Commons uses writes to keep agents off the same code, and writes∩reads plus dependsOn to order landings.

Goal:
${goal}

Repository digest (paths are repository-relative; exports as name: signature):
${digest}

Decompose the goal into tasks that together achieve it. Rules:
1. Produce between ${MIN_TASKS} and ${maxTasks} tasks. Size each so that one agent finishes it in one session (roughly one to three files of focused change plus tests); split anything larger.
2. "id" is kebab-case, unique, and descriptive, for example "add-user-email".
3. "body" is self-contained: say what to change, in which files and exported symbols, the intended behavior, and how it serves the goal. Name the files and symbols the task relies on instead of referring to other tasks.
4. "writes" lists every file the task will change, as {"path", "symbols"} with the exported symbols it adds or changes (an empty "symbols" means the whole file is in scope). Copy paths exactly from the digest. A file that does not exist yet must carry "new": true and use a sensible path under an existing directory.
5. "reads" lists files the task relies on but does not change, as {"path"}: exact digest paths, or the new files of a task it depends on.
6. Minimize write overlap: two tasks should not write the same file or the same symbol; split work by file or by symbol instead.
7. Put interface and contract changes (new exports, changed signatures, new types) in producer tasks; a consumer lists those producers in "dependsOn" and its body states the contract it expects (names and signatures).
8. "dependsOn" holds only ids from this plan, and only when the task cannot be completed or verified until that producer has landed; keep it empty otherwise.
9. Every task includes its tests: the body names the test file(s) to add or extend (listed in "writes") and what they must assert, and the agent must make them pass before submitting.

Reply with only JSON, no prose and no code fences: {"tasks": [{"id", "title", "body", "writes": [{"path", "symbols": [], "new": false}], "reads": [{"path"}], "dependsOn": []}, ...]}.`;
}
/** Structured-output schema for `claude --json-schema` (the root must be an object, so the array is wrapped). */
export const OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        tasks: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    body: { type: "string" },
                    writes: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: { path: { type: "string" }, symbols: { type: "array", items: { type: "string" } }, new: { type: "boolean" } },
                            required: ["path", "symbols", "new"],
                            additionalProperties: false,
                        },
                    },
                    reads: {
                        type: "array",
                        items: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
                    },
                    dependsOn: { type: "array", items: { type: "string" } },
                },
                required: ["id", "title", "body", "writes", "reads", "dependsOn"],
                additionalProperties: false,
            },
        },
    },
    required: ["tasks"],
    additionalProperties: false,
};
// ---------------------------------------------------------------------------------------------
// Model call
function decomposerCommand(opts) {
    if (opts.command && opts.command.length > 0)
        return opts.command;
    const env = process.env.COMMONS_DECOMPOSER_CMD;
    if (env)
        return env.split(" ").filter(Boolean);
    return null;
}
function runWithInput(cmd, args, input, timeout) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
        child.stdout.on("data", (d) => (out += d.toString("utf8")));
        child.stderr.on("data", (d) => (err += d.toString("utf8")));
        child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve(out);
            else
                reject(new Error(`${cmd} exited with ${code}: ${err.slice(-500)}`));
        });
        child.stdin.end(input);
    });
}
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** The result object `claude -p --output-format json` prints (tolerates an array of messages or stray lines). */
function claudeResult(stdout) {
    const text = stdout.trim();
    if (!text)
        return null;
    const pick = (v) => {
        if (Array.isArray(v)) {
            const result = v.find((m) => isObject(m) && m.type === "result") ?? v[v.length - 1];
            return isObject(result) ? result : null;
        }
        return isObject(v) ? v : null;
    };
    try {
        return pick(JSON.parse(text));
    }
    catch {
        // fall through to line scanning
    }
    for (const line of text.split(/\r?\n/).reverse()) {
        if (!line.trim().startsWith("{"))
            continue;
        try {
            const v = JSON.parse(line);
            if (isObject(v) && v.type === "result")
                return v;
        }
        catch {
            // not a JSON line
        }
    }
    return null;
}
function stripFences(text) {
    const m = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(text);
    return m ? m[1] : text;
}
/** The task list from a parsed reply: a bare array or `{tasks: [...]}`. */
function tasksOf(value) {
    if (Array.isArray(value))
        return value;
    if (isObject(value) && Array.isArray(value.tasks))
        return value.tasks;
    return null;
}
/** Parse the planner's text reply: JSON, optionally fenced, optionally surrounded by prose. */
export function parseReply(text) {
    const clean = stripFences(text).trim();
    try {
        const tasks = tasksOf(JSON.parse(clean));
        if (tasks)
            return tasks;
    }
    catch {
        // try the outermost bracket pair below
    }
    for (const [open, close] of [["{", "}"], ["[", "]"]]) {
        const start = clean.indexOf(open);
        const end = clean.lastIndexOf(close);
        if (start < 0 || end <= start)
            continue;
        try {
            const tasks = tasksOf(JSON.parse(clean.slice(start, end + 1)));
            if (tasks)
                return tasks;
        }
        catch {
            // keep looking
        }
    }
    throw new Error(`planner reply is not a JSON task list: ${truncate(clean.replace(/\s+/g, " "), 200)}`);
}
async function askClaude(prompt, model, timeout) {
    const args = [
        "-p", prompt,
        "--max-turns", "1",
        "--output-format", "json",
        "--model", model,
        "--strict-mcp-config",
        "--setting-sources", "project",
        "--permission-mode", "dontAsk",
        "--json-schema", JSON.stringify(OUTPUT_SCHEMA),
    ];
    let stdout;
    try {
        // Not --bare: on macOS that mode skips the keychain credentials and every call ends in api_error.
        ({ stdout } = await run("claude", args, { maxBuffer: 64 * 1024 * 1024, timeout, env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } }));
    }
    catch (error) {
        const e = error;
        const result = claudeResult(e.stdout ?? "");
        const detail = (typeof result?.result === "string" && result.result) || (e.stderr ?? "").trim().slice(-500) || e.message || String(error);
        throw new Error(`claude failed: ${detail}`);
    }
    const result = claudeResult(stdout);
    if (!result)
        throw new Error("claude printed no result object");
    if (result.is_error || result.terminal_reason === "api_error") {
        throw new Error(`claude failed: ${typeof result.result === "string" ? result.result : (result.terminal_reason ?? "unknown error")}`);
    }
    if (result.structured_output !== undefined) {
        const tasks = tasksOf(result.structured_output);
        if (tasks)
            return tasks;
    }
    if (typeof result.result !== "string")
        throw new Error("claude returned no result text");
    return parseReply(result.result);
}
async function askModel(prompt, opts) {
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const override = decomposerCommand(opts);
    if (override)
        return parseReply(await runWithInput(override[0], override.slice(1), prompt, timeout));
    return askClaude(prompt, opts.model ?? DEFAULT_MODEL, timeout);
}
// ---------------------------------------------------------------------------------------------
// Validation
const pathLike = (schema) => z.preprocess((v) => (typeof v === "string" ? { path: v } : v), schema);
const WriteSchema = pathLike(z.object({ path: z.string().trim().min(1), symbols: z.array(z.string()).optional(), new: z.boolean().optional() }));
const ReadSchema = pathLike(z.object({ path: z.string().trim().min(1) }));
const RawTaskSchema = z.object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    body: z.string().default(""),
    writes: z.array(WriteSchema).default([]),
    reads: z.array(ReadSchema).default([]),
    dependsOn: z.array(z.string()).default([]),
});
function toKebab(text) {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function normalizePath(path) {
    return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
/** Relative, inside the repository, and a file (no trailing slash, no `..` or empty segments). */
function sanePath(path) {
    if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.endsWith("/"))
        return false;
    return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function knownPath(index, path) {
    if (index.byPath.has(path))
        return true;
    return index.root !== "" && sanePath(path) && existsSync(join(index.root, path));
}
function uniqueStrings(items) {
    return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}
/**
 * Validate a raw planner reply against the index: tasks whose writes name paths that are neither known
 * (indexed or on disk) nor marked new are dropped, reads are filtered to known paths and other tasks' new
 * files, ids are made kebab-case and unique, dependsOn edges to unknown ids are dropped, and the list is cut
 * to `maxTasks` (dropping tasks nobody depends on first). Throws when fewer than two tasks survive.
 */
export function validateTasks(raw, index, opts = {}) {
    const maxTasks = Math.max(MIN_TASKS, Math.floor(opts.maxTasks ?? DEFAULT_MAX_TASKS));
    const dropped = [];
    const warn = (message) => {
        dropped.push(message);
        opts.warn?.(message);
    };
    // 1. Shape.
    const parsed = [];
    raw.forEach((item, i) => {
        const result = RawTaskSchema.safeParse(item);
        if (result.success)
            parsed.push(result.data);
        else
            warn(`dropped task #${i + 1}: ${result.error.issues.map((issue) => `${issue.path.join(".") || "task"}: ${issue.message}`).join("; ")}`);
    });
    // 2. Ids: kebab-case, unique; remember the model's spelling for dependsOn.
    const idMap = new Map();
    const used = new Set();
    const withIds = parsed.map((task, i) => {
        let id = toKebab(task.id) || toKebab(task.title) || `task-${i + 1}`;
        if (used.has(id)) {
            let n = 2;
            while (used.has(`${id}-${n}`))
                n++;
            id = `${id}-${n}`;
        }
        used.add(id);
        if (!idMap.has(task.id))
            idMap.set(task.id, id);
        if (!idMap.has(task.id.trim()))
            idMap.set(task.id.trim(), id);
        return { ...task, id };
    });
    const kept = [];
    for (const task of withIds) {
        const byPath = new Map();
        const bad = [];
        for (const write of task.writes) {
            const path = normalizePath(write.path);
            const ok = knownPath(index, path) || (write.new === true && sanePath(path));
            if (!ok) {
                bad.push(write.path);
                continue;
            }
            const scope = byPath.get(path) ?? { path };
            const symbols = uniqueStrings([...(scope.symbols ?? []), ...(write.symbols ?? [])]);
            if (symbols.length > 0)
                scope.symbols = symbols;
            byPath.set(path, scope);
        }
        if (bad.length > 0) {
            warn(`dropped task ${task.id}: writes ${bad.map((p) => JSON.stringify(p)).join(", ")} ${bad.length === 1 ? "is" : "are"} not in the repository and not marked new`);
            continue;
        }
        kept.push({ id: task.id, title: task.title.trim(), body: task.body, writes: [...byPath.values()], reads: task.reads.map((r) => normalizePath(r.path)), dependsOn: task.dependsOn });
    }
    // 4. Cut to maxTasks, dropping tasks nobody depends on first (from the end).
    if (kept.length > maxTasks) {
        const resolveId = (id) => idMap.get(id) ?? idMap.get(id.trim()) ?? toKebab(id);
        const dependedOn = new Set(kept.flatMap((t) => t.dependsOn.map(resolveId)));
        for (let i = kept.length - 1; i >= 0 && kept.length > maxTasks; i--) {
            if (dependedOn.has(kept[i].id))
                continue;
            warn(`dropped task ${kept[i].id}: more than ${maxTasks} tasks were proposed`);
            kept.splice(i, 1);
        }
        while (kept.length > maxTasks) {
            const removed = kept.pop();
            warn(`dropped task ${removed.id}: more than ${maxTasks} tasks were proposed`);
        }
    }
    // 5. Reads and dependsOn against the surviving tasks.
    const ids = new Set(kept.map((t) => t.id));
    const allWrites = new Set(kept.flatMap((t) => t.writes.map((w) => w.path)));
    const tasks = kept.map((task) => {
        const ownWrites = new Set(task.writes.map((w) => w.path));
        const reads = [];
        const seen = new Set();
        for (const path of task.reads) {
            if (seen.has(path) || ownWrites.has(path))
                continue;
            if (!knownPath(index, path) && !allWrites.has(path)) {
                warn(`task ${task.id}: dropped read ${JSON.stringify(path)}, not in the repository`);
                continue;
            }
            seen.add(path);
            reads.push({ path });
        }
        const dependsOn = [];
        for (const dep of task.dependsOn) {
            const id = idMap.get(dep) ?? idMap.get(dep.trim()) ?? (ids.has(toKebab(dep)) ? toKebab(dep) : undefined);
            if (id === undefined || !ids.has(id)) {
                warn(`task ${task.id}: dropped dependsOn ${JSON.stringify(dep)}, no such task`);
                continue;
            }
            if (id === task.id || dependsOn.includes(id))
                continue;
            dependsOn.push(id);
        }
        return { id: task.id, title: task.title, body: task.body, writes: task.writes, reads, dependsOn };
    });
    if (tasks.length < MIN_TASKS) {
        const reasons = dropped.length > 0 ? `\n${dropped.map((d) => `  - ${d}`).join("\n")}` : "";
        throw new Error(`decomposition produced ${tasks.length} valid task${tasks.length === 1 ? "" : "s"} out of ${raw.length}; at least ${MIN_TASKS} are needed${reasons}`);
    }
    return tasks;
}
// ---------------------------------------------------------------------------------------------
/** Decompose `goal` into validated, parallelizable tasks grounded in `index` (see the module comment). */
export async function decomposeGoal(opts) {
    const goal = opts.goal.trim();
    if (!goal)
        throw new Error("goal is empty");
    const maxTasks = Math.max(MIN_TASKS, Math.floor(opts.maxTasks ?? DEFAULT_MAX_TASKS));
    const prompt = buildPrompt(goal, buildDigest(opts.index, goal), maxTasks);
    const raw = await askModel(prompt, opts);
    return validateTasks(raw, opts.index, { maxTasks, warn: opts.warn });
}
//# sourceMappingURL=decompose.js.map