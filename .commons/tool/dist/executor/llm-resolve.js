// Model-based conflict resolution inside the executor, used only after the structured merges fail and always
// gated by the batch's tests. It moves conflict resolution off the agent's turn: the agent never sees the bounce.
// The resolver is `claude -p` by default; `command` (or COMMONS_LLM_RESOLVER_CMD) overrides it for tests and
// other models: the command receives the diff3-marked file on stdin and must print the resolved file.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { showFile } from "./git.js";
import { buildResolvedTree } from "./structured-merge.js";
const run = promisify(execFile);
const zeroUsage = () => ({ costUsd: 0, input: 0, cachedInput: 0, cacheCreation: 0, output: 0 });
let claudeAvailability;
export function llmResolveAvailable(opts = {}) {
    if (resolverCommand(opts))
        return Promise.resolve(true);
    if (!claudeAvailability) {
        claudeAvailability = run("claude", ["--version"], { timeout: 15_000 })
            .then(() => true)
            .catch(() => false);
    }
    return claudeAvailability;
}
function resolverCommand(opts) {
    if (opts.command && opts.command.length > 0)
        return opts.command;
    const env = process.env.COMMONS_LLM_RESOLVER_CMD;
    if (env)
        return env.split(" ").filter(Boolean);
    return null;
}
const CONFLICT_RE = /^<{7}[^\n]*\n[\s\S]*?^>{7}[^\n]*\n?/gm;
const CONTEXT_LINES = 60;
const PARALLEL = 4;
export const LANDED_HEADING = "### What already landed on main (preserve exactly)";
export const COMPOSITION_RULE = "Rule: when both sides extend the same signature, accept both shapes; never drop or reorder a landed parameter.";
export const INCOMING_LABEL = "What the incoming change is for";
const PROMPT = (path, evidence, before, block, after) => `You are the merge integrator for a repository where several engineers extend the same code concurrently. Below is one git conflict from ${path} in diff3 style (<<<<<<< ours, ||||||| base, =======, >>>>>>> theirs) with surrounding context. "ours" is what already landed on main; "theirs" is a new change being integrated.

Resolve the conflict so that BOTH sides' functionality is preserved: keep landed parameters, fields and behavior in place; add the new side's additions without shifting or renaming existing ones; when both sides extend the same signature or structure, compose them (for example accept both a function and an options object) rather than picking one. Keep the result syntactically valid in context.

Reply with ONLY the lines that replace the conflict block (everything from the <<<<<<< line through the >>>>>>> line). Do not repeat the context, do not explain, no code fences.

${evidence}### context before
${before}
### conflict
${block}### context after
${after}`;
/**
 * The evidence sections of the prompt for `path`: the exported signatures that already changed on main, as
 * `symbol: before -> after` lines under the task that landed them (a symbol of another conflicted file names
 * it), the composition rule, and what the incoming change is for. Empty when there is nothing to tell.
 */
export function renderEvidence(path, evidence) {
    if (!evidence)
        return "";
    const sections = [];
    const landed = evidence.landed.filter((l) => l.contractChanges.length > 0 || l.summary);
    if (landed.length > 0) {
        const lines = [LANDED_HEADING];
        for (const l of landed) {
            lines.push(`From ${l.taskId}${l.summary ? ` (${l.summary})` : ""}:`);
            for (const c of l.contractChanges) {
                lines.push(`  ${c.symbol}${c.path === path ? "" : ` (in ${c.path})`}: ${c.before} -> ${c.after}`);
            }
        }
        lines.push(COMPOSITION_RULE);
        sections.push(lines.join("\n"));
    }
    if (evidence.incoming)
        sections.push(`${INCOMING_LABEL} (${evidence.incoming.taskId}): ${evidence.incoming.summary}`);
    return sections.length > 0 ? `${sections.join("\n\n")}\n\n` : "";
}
function splitConflicts(content) {
    const segments = [];
    let last = 0;
    for (const m of content.matchAll(CONFLICT_RE)) {
        if (m.index > last)
            segments.push({ kind: "text", text: content.slice(last, m.index) });
        segments.push({ kind: "conflict", text: m[0] });
        last = m.index + m[0].length;
    }
    if (last < content.length)
        segments.push({ kind: "text", text: content.slice(last) });
    return segments;
}
const tailLines = (text, n) => text.split("\n").slice(-n).join("\n");
const headLines = (text, n) => text.split("\n").slice(0, n).join("\n");
function modelReply(stdout) {
    const empty = { text: null, usage: zeroUsage() };
    try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return empty;
        const result = parsed;
        const usage = typeof result.usage === "object" && result.usage !== null ? result.usage : {};
        const number = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
        return {
            text: result.is_error || result.terminal_reason === "api_error" || typeof result.result !== "string" ? null : result.result,
            usage: {
                costUsd: number(result.total_cost_usd),
                input: number(usage.input_tokens),
                cachedInput: number(usage.cache_read_input_tokens),
                cacheCreation: number(usage.cache_creation_input_tokens),
                output: number(usage.output_tokens),
            },
        };
    }
    catch {
        return empty;
    }
}
async function askModel(prompt, opts) {
    const empty = { text: null, usage: zeroUsage() };
    if (opts.signal?.aborted)
        return null;
    const timeout = opts.timeoutMs ?? 120_000;
    const override = resolverCommand(opts);
    try {
        if (override)
            return { text: await runWithInput(override[0], override.slice(1), prompt, timeout, opts.signal), usage: zeroUsage() };
        const r = await run("claude", 
        // Not --bare: on macOS that mode skips the keychain credentials and every call ends in api_error.
        ["-p", prompt, "--max-turns", "1", "--output-format", "json", "--model", opts.model ?? "sonnet", "--strict-mcp-config", "--setting-sources", "project", "--permission-mode", "dontAsk"], { maxBuffer: 64 * 1024 * 1024, timeout, signal: opts.signal, env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } });
        return modelReply(r.stdout);
    }
    catch (error) {
        // execFile rejects on nonzero exit, but Claude can still have emitted a billable result object.
        if (!override && typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
            return { ...modelReply(error.stdout), text: null };
        }
        return empty;
    }
}
/** Resolve every conflict block of one file, in parallel, keeping the untouched text verbatim. */
async function resolveOne(path, content, opts, evidence) {
    const segments = splitConflicts(content);
    const blocks = segments.map((seg, i) => ({ seg, i })).filter(({ seg }) => seg.kind === "conflict");
    if (blocks.length === 0)
        return null;
    const rendered = renderEvidence(path, evidence);
    const replacements = new Map();
    for (let start = 0; start < blocks.length; start += PARALLEL) {
        const batch = blocks.slice(start, start + PARALLEL);
        const results = await Promise.all(batch.map(async ({ seg, i }) => {
            const before = segments[i - 1]?.kind === "text" ? tailLines(segments[i - 1].text, CONTEXT_LINES) : "";
            const after = segments[i + 1]?.kind === "text" ? headLines(segments[i + 1].text, CONTEXT_LINES) : "";
            const reply = await askModel(PROMPT(path, rendered, before, seg.text, after), opts);
            if (reply === null)
                return null; // No invocation took place after the budget expired.
            opts.onUsage?.(reply.usage);
            if (reply.text === null)
                return null;
            let text = stripFences(reply.text).replace(/\s+$/, "");
            if (/^(<{7}|\|{7}|={7}|>{7})/m.test(text))
                return null;
            text = text.length > 0 ? text + "\n" : "";
            return { i, text };
        }));
        for (const r of results) {
            if (r === null)
                return null;
            replacements.set(r.i, r.text);
        }
    }
    const out = segments.map((seg, i) => (seg.kind === "conflict" ? replacements.get(i) : seg.text)).join("");
    if (/^(<{7}|\|{7}|={7}|>{7})/m.test(out))
        return null;
    return out;
}
function runWithInput(cmd, args, input, timeout, signal) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
        let out = "";
        let err = "";
        const kill = () => child.kill("SIGKILL");
        const timer = setTimeout(kill, timeout);
        signal?.addEventListener("abort", kill, { once: true });
        const settle = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", kill);
        };
        child.stdout.on("data", (d) => (out += d.toString("utf8")));
        child.stderr.on("data", (d) => (err += d.toString("utf8")));
        child.stdin.on("error", () => { }); // the child may exit, or be killed, before it reads its stdin
        child.on("error", (e) => {
            settle();
            reject(e);
        });
        child.on("close", (code) => {
            settle();
            if (signal?.aborted)
                reject(new Error(`${cmd} aborted`));
            else if (code === 0)
                resolve(out);
            else
                reject(new Error(`${cmd} exited with ${code}: ${err.slice(-500)}`));
        });
        if (signal?.aborted)
            kill();
        child.stdin.end(input);
    });
}
export function stripFences(text) {
    const m = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(text);
    return m ? m[1] : text;
}
/** Resolve the conflicted files of a merge with the model; null when any file cannot be resolved. */
export async function llmResolveFiles(work, conflictedTree, conflicts, opts = {}, evidence) {
    if (conflicts.length === 0)
        return null;
    const maxBytes = opts.maxBytes ?? 200 * 1024;
    const resolutions = [];
    for (const { path } of conflicts) {
        const content = await showFile(work, conflictedTree, path);
        if (content === null || Buffer.byteLength(content) > maxBytes || !content.includes("<<<<<<<"))
            return null;
        const resolved = await resolveOne(path, content, opts, evidence);
        if (resolved === null)
            return null;
        resolutions.push({ path, conflicted: content, content: resolved });
    }
    return resolutions;
}
export async function llmResolve(work, conflictedTree, ours, conflicts, opts = {}, evidence) {
    const calls = [];
    const resolutions = await llmResolveFiles(work, conflictedTree, conflicts, {
        ...opts,
        onUsage: (usage) => {
            calls.push(usage);
            opts.onUsage?.(usage);
        },
    }, evidence);
    if (resolutions === null)
        return null;
    return { ...(await buildResolvedTree(work, conflictedTree, ours, resolutions)), resolutions, calls, costUsd: calls.reduce((sum, call) => sum + call.costUsd, 0) };
}
// Conflict marker labels name the commits merged, so the same conflict merged onto a later candidate differs
// only there.
const MARKER_LABEL_RE = /^(<{7}|\|{7}|>{7})[^\n]*/gm;
const normalizeMarkers = (content) => content.replace(MARKER_LABEL_RE, "$1");
/**
 * Apply an earlier resolution of the same submission to a new merge of it (the candidate moved under it when an
 * earlier resolution landed). Valid only when every conflicted path has a prior resolution of the same conflicted
 * content apart from the marker labels; otherwise null, and the model has to be asked again.
 */
export async function reapplyResolutions(work, conflictedTree, ours, conflicts, prior) {
    if (conflicts.length === 0)
        return null;
    const byPath = new Map(prior.map((r) => [r.path, r]));
    const resolutions = [];
    for (const { path } of conflicts) {
        const earlier = byPath.get(path);
        if (!earlier)
            return null;
        const content = await showFile(work, conflictedTree, path);
        if (content === null || normalizeMarkers(content) !== normalizeMarkers(earlier.conflicted))
            return null;
        resolutions.push({ path, conflicted: content, content: earlier.content });
    }
    return { ...(await buildResolvedTree(work, conflictedTree, ours, resolutions)), resolutions, calls: [], costUsd: 0 };
}
//# sourceMappingURL=llm-resolve.js.map