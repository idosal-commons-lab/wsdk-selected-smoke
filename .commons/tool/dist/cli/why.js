// `commons why <commit>` and `commons search <text>`: read the landing notes Commons keeps in refs/notes/commons.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TASK_HEADING } from "../brief/brief.js";
import { gitRaw } from "../executor/git.js";
import { DEFAULT_SEARCH_LIMIT, fetchNotes, readLandingNote, searchNotes } from "../executor/notes.js";
export const WHY_USAGE = "Usage: commons why <commit-or-ref> [--repo <dir>] [--remote <url>]\n";
export const SEARCH_USAGE = "Usage: commons search <text> [--repo <dir>] [--remote <url>] [--limit N]\n";
const METHOD_TEXT = {
    merge: "clean merge",
    replay: "structural replay",
    "syntax-aware": "syntax-aware merge",
    "model-resolved": "model-resolved conflict",
    ancestor: "already contained in main",
};
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function short(sha) {
    return sha.slice(0, 12);
}
function seconds(ms) {
    return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
}
/** The task section of a brief (from the first "## Task" heading), or the whole brief when it has none. */
export function briefTaskSection(brief) {
    const at = brief.indexOf(TASK_HEADING);
    return (at < 0 ? brief : brief.slice(at + 1)).trimEnd();
}
/** The note as readable Markdown. */
export function renderLandingNote(commit, note) {
    const lines = [];
    lines.push(note.title ? `# ${note.taskId}: ${note.title}` : `# ${note.taskId}`);
    lines.push("", note.summary, "");
    lines.push(`- Commit: ${commit}`);
    lines.push(`- Landed: ${new Date(note.landedAt).toISOString()} (batch ${note.batchId}, submission ${note.submissionId})`);
    lines.push(`- Main: ${short(note.fromMain)} -> ${short(note.toMain)}`);
    lines.push(`- Method: ${METHOD_TEXT[note.method] ?? note.method}`);
    if (note.agent) {
        const details = [note.agent.kind, note.agent.model].filter((v) => Boolean(v)).join(", ");
        lines.push(`- Agent: ${note.agent.sessionId ? `session ${note.agent.sessionId}` : "unknown session"}${details ? ` (${details})` : ""}`);
    }
    lines.push("", "## Checks");
    if (note.checks.length === 0)
        lines.push("(none)");
    for (const c of note.checks) {
        const facts = [c.passed ? "passed" : "failed", ...(c.cached ? ["cached"] : []), seconds(c.durationMs)].join(", ");
        lines.push(`- ${c.id}: ${facts}`);
        for (const t of c.failedTests ?? [])
            lines.push(`  - ${t}`);
    }
    lines.push("", "## Contract changes");
    if (note.contractChanges.length === 0)
        lines.push("(none)");
    for (const c of note.contractChanges)
        lines.push(`- ${c.path} \`${c.symbol}\`: \`${c.before}\` -> \`${c.after}\``);
    if (note.symbolsChanged.length > 0) {
        lines.push("", "## Symbols changed");
        for (const s of note.symbolsChanged)
            lines.push(`- ${s.path}: ${s.symbols.join(", ")}`);
    }
    if (note.brief)
        lines.push("", "## Brief", "", briefTaskSection(note.brief));
    return lines.join("\n") + "\n";
}
/** The bare host recorded in the nearest .commons/config.json above `repo`, unless it is `repo` itself. */
function configuredHost(repo) {
    let current = resolve(repo);
    for (;;) {
        const path = join(current, ".commons", "config.json");
        if (existsSync(path)) {
            try {
                const host = JSON.parse(readFileSync(path, "utf8")).host;
                return typeof host === "string" && resolve(host) !== resolve(repo) ? host : null;
            }
            catch {
                return null;
            }
        }
        const parent = dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
const COMMON = {
    repo: { type: "string" },
    remote: { type: "string" },
    // Accepted for uniformity with the other commands; the notes commands do not talk to the coordinator.
    url: { type: "string" },
    token: { type: "string" },
};
export async function whyCommand(args, io) {
    let parsed;
    try {
        parsed = parseArgs({ args, options: COMMON, allowPositionals: true, strict: true });
    }
    catch (error) {
        io.stderr.write(`${messageOf(error)}\n${WHY_USAGE}`);
        return 2;
    }
    const ref = parsed.positionals[0];
    if (!ref || parsed.positionals.length > 1) {
        io.stderr.write(WHY_USAGE);
        return 2;
    }
    const repo = resolve(parsed.values.repo ?? process.cwd());
    const resolved = await gitRaw(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (resolved.code !== 0) {
        io.stderr.write(`error: ${resolved.stderr.trim() || `${ref} is not a commit in ${repo}`}\n`);
        return 1;
    }
    const commit = resolved.stdout.trim();
    const explicit = parsed.values.remote;
    let note = await readLandingNote(repo, commit, explicit);
    if (!note && !explicit) {
        const host = configuredHost(repo);
        if (host) {
            try {
                note = await readLandingNote(repo, commit, host);
            }
            catch (error) {
                io.stderr.write(`warning: could not fetch notes from ${host}: ${messageOf(error)}\n`);
            }
        }
    }
    if (!note) {
        io.stderr.write(`no Commons note for ${commit}\n`);
        return 1;
    }
    io.stdout.write(renderLandingNote(commit, note));
    return 0;
}
export async function searchCommand(args, io) {
    const options = { ...COMMON, limit: { type: "string" } };
    let parsed;
    try {
        parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    }
    catch (error) {
        io.stderr.write(`${messageOf(error)}\n${SEARCH_USAGE}`);
        return 2;
    }
    const query = parsed.positionals.join(" ").trim();
    if (!query) {
        io.stderr.write(SEARCH_USAGE);
        return 2;
    }
    const limitArg = parsed.values.limit;
    if (limitArg !== undefined && !/^[1-9]\d*$/.test(limitArg)) {
        io.stderr.write(`--limit must be a positive integer\n${SEARCH_USAGE}`);
        return 2;
    }
    const limit = limitArg === undefined ? DEFAULT_SEARCH_LIMIT : Number(limitArg);
    const repo = resolve(parsed.values.repo ?? process.cwd());
    const remote = parsed.values.remote ?? configuredHost(repo);
    if (remote) {
        try {
            await fetchNotes(repo, remote);
        }
        catch (error) {
            io.stderr.write(`warning: could not fetch notes from ${remote}: ${messageOf(error)}\n`);
        }
    }
    const hits = await searchNotes(repo, query, limit);
    if (hits.length === 0) {
        io.stderr.write(`no Commons notes match "${query}"\n`);
        return 1;
    }
    for (const hit of hits)
        io.stdout.write(`${short(hit.commit)}  ${hit.note.taskId}  ${hit.note.title ?? hit.note.summary}\n`);
    return 0;
}
//# sourceMappingURL=why.js.map