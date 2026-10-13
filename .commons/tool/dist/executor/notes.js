// Landing notes: the "why" of every commit Commons lands, kept in git under refs/notes/commons.
//
// One JSON note per landing commit (the merge commit the executor creates; the task's own commit
// when it was already contained in main). The executor writes the note when it lands a submission
// and pushes the notes ref to the host right after main, so `git log --notes=commons`,
// `commons why <commit>` and `commons search <text>` work in any clone that fetched the ref.
import { spawn } from "node:child_process";
import { TASK_HEADING } from "../brief/brief.js";
import { git, gitEnv, gitRaw, GitError } from "./git.js";
export const NOTES_REF = "refs/notes/commons";
/** Longest brief stored in a note (bytes); the task section is kept whole when it fits. */
export const MAX_BRIEF_BYTES = 16 * 1024;
/** Newest landings consulted by a search. */
export const MAX_SEARCH_COMMITS = 500;
export const DEFAULT_SEARCH_LIMIT = 50;
const TRUNCATED = "\n…(truncated)\n";
/** Cut `s` to at most `max` UTF-8 bytes on a character boundary. */
function truncateBytes(s, max) {
    if (Buffer.byteLength(s, "utf8") <= max)
        return s;
    return Buffer.from(s, "utf8").subarray(0, Math.max(0, max)).toString("utf8").replace(/�$/, "");
}
/** Keep a brief under MAX_BRIEF_BYTES, sacrificing the repo section before the task section. */
export function capBrief(brief) {
    if (Buffer.byteLength(brief, "utf8") <= MAX_BRIEF_BYTES)
        return brief;
    const budget = MAX_BRIEF_BYTES - Buffer.byteLength(TRUNCATED, "utf8");
    const at = brief.indexOf(TASK_HEADING);
    if (at >= 0) {
        const task = brief.slice(at);
        const taskBytes = Buffer.byteLength(task, "utf8");
        if (taskBytes <= budget)
            return `${truncateBytes(brief.slice(0, at), budget - taskBytes)}${TRUNCATED}${task}`;
    }
    return `${truncateBytes(brief, budget)}${TRUNCATED}`;
}
/** Build the note for one landing from what the executor has in hand. */
export function landingNoteFrom(input) {
    const method = input.fromMain === input.toMain ? "ancestor" : (input.resolved ?? "merge");
    const note = {
        v: 1,
        taskId: input.submission.taskId,
        summary: input.submission.summary,
        submissionId: input.submission.id,
        batchId: input.batchId,
        method,
        landedAt: input.landedAt ?? Date.now(),
        fromMain: input.fromMain,
        toMain: input.toMain,
        checks: input.checks.map((r) => ({
            id: r.id,
            passed: r.passed,
            cached: r.cached,
            durationMs: r.durationMs,
            ...(r.failedTests.length > 0 ? { failedTests: r.failedTests } : {}),
        })),
        contractChanges: input.changed.flatMap((c) => c.contractChanges.map((cc) => ({ path: c.path, ...cc }))),
        symbolsChanged: input.changed.filter((c) => c.symbolsChanged.length > 0).map((c) => ({ path: c.path, symbols: c.symbolsChanged })),
    };
    if (input.title !== undefined)
        note.title = input.title;
    if (input.agent && Object.values(input.agent).some((v) => v !== undefined))
        note.agent = input.agent;
    if (input.brief !== undefined)
        note.brief = capBrief(input.brief);
    return note;
}
/** Parse a note body; null when it is not a v1 landing note. */
export function parseLandingNote(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof value !== "object" || value === null)
        return null;
    const note = value;
    if (note.v !== 1 || typeof note.taskId !== "string" || typeof note.summary !== "string" || typeof note.toMain !== "string")
        return null;
    return {
        ...note,
        checks: Array.isArray(note.checks) ? note.checks : [],
        contractChanges: Array.isArray(note.contractChanges) ? note.contractChanges : [],
        symbolsChanged: Array.isArray(note.symbolsChanged) ? note.symbolsChanged : [],
    };
}
/** Run git with `input` on stdin; stdout is returned as bytes (cat-file sizes are in bytes). */
function gitWithStdin(cwd, args, input) {
    const fullArgs = ["-C", cwd, ...args];
    return new Promise((resolve, reject) => {
        const child = spawn("git", fullArgs, { env: gitEnv(cwd), stdio: ["pipe", "pipe", "pipe"] });
        const out = [];
        const err = [];
        child.stdout.on("data", (chunk) => out.push(chunk));
        child.stderr.on("data", (chunk) => err.push(chunk));
        child.on("error", (error) => reject(new GitError(`git ${args.join(" ")} could not run: ${error.message}`, fullArgs, null, "", "")));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
        child.stdin.on("error", () => {
            // git exited before reading everything; the exit code carries the verdict.
        });
        child.stdin.end(input);
    });
}
/**
 * Attach `note` to `commit` under refs/notes/commons. A merge note replaces whatever was there; an
 * "ancestor" note never overwrites an existing note (the earlier landing carries more information).
 */
export async function writeLandingNote(work, commit, note) {
    const force = note.method !== "ancestor";
    // -F - reads the body from stdin, so the payload never goes through argv.
    const args = ["notes", `--ref=${NOTES_REF}`, "add", ...(force ? ["-f"] : []), "-F", "-", commit];
    const r = await gitWithStdin(work, args, JSON.stringify(note, null, 2) + "\n");
    if (r.code === 0)
        return;
    if (!force && /Found existing notes/.test(r.stderr))
        return;
    throw new GitError(`git ${args.join(" ")} failed (exit ${r.code}): ${r.stderr.trim()}`, ["-C", work, ...args], r.code, "", r.stderr);
}
/** Push the notes ref to the host. A no-op when this clone has written no notes yet. */
export async function pushNotes(work, hostUrl) {
    const have = await gitRaw(work, ["rev-parse", "--verify", "--quiet", `${NOTES_REF}^{commit}`]);
    if (have.code !== 0)
        return;
    await git(work, ["push", "--quiet", hostUrl, `+${NOTES_REF}:${NOTES_REF}`]);
}
/** Fetch the notes ref from `remote`. False when the remote has no notes yet; other failures throw. */
export async function fetchNotes(repo, remote) {
    const r = await gitRaw(repo, ["fetch", "--quiet", remote, `+${NOTES_REF}:${NOTES_REF}`]);
    if (r.code === 0)
        return true;
    if (/couldn't find remote ref/i.test(r.stderr))
        return false;
    throw new GitError(`git fetch ${remote} ${NOTES_REF} failed (exit ${r.code}): ${r.stderr.trim()}`, ["fetch", remote], r.code, r.stdout, r.stderr);
}
/** The landing note on `commit`, fetching the notes ref from `remote` first when given. Null when there is none. */
export async function readLandingNote(repo, commit, remote) {
    if (remote && !(await fetchNotes(repo, remote)))
        return null;
    const r = await gitRaw(repo, ["notes", `--ref=${NOTES_REF}`, "show", commit]);
    if (r.code === 0)
        return parseLandingNote(r.stdout);
    if (/no note found|failed to resolve|not a valid/i.test(r.stderr))
        return null;
    throw new GitError(`git notes show ${commit} failed (exit ${r.code}): ${r.stderr.trim()}`, ["notes", "show", commit], r.code, r.stdout, r.stderr);
}
/** Parse `git cat-file --batch` output into blob sha -> body. */
function parseBatch(buf) {
    const out = new Map();
    let offset = 0;
    while (offset < buf.length) {
        const nl = buf.indexOf(0x0a, offset);
        if (nl < 0)
            break;
        const [sha, type, size] = buf.subarray(offset, nl).toString("utf8").split(" ");
        offset = nl + 1;
        if (!sha || type !== "blob")
            continue; // "missing" or an unexpected object type
        const length = Number.parseInt(size ?? "", 10);
        if (!Number.isFinite(length))
            break;
        out.set(sha, buf.subarray(offset, offset + length).toString("utf8"));
        offset += length + 1; // the newline cat-file appends after each object
    }
    return out;
}
/** The newest `max` landing notes in `repo`, newest first. */
export async function loadNotes(repo, max = MAX_SEARCH_COMMITS) {
    // `notes list` exits 0 with no output when the ref does not exist; a failure is a real one (not a repository, ...).
    const list = await gitRaw(repo, ["notes", `--ref=${NOTES_REF}`, "list"]);
    if (list.code !== 0) {
        throw new GitError(`git notes list failed (exit ${list.code}): ${list.stderr.trim()}`, ["notes", "list"], list.code, list.stdout, list.stderr);
    }
    const blobOf = new Map();
    for (const line of list.stdout.split("\n")) {
        const [blob, commit] = line.trim().split(" ");
        if (blob && commit)
            blobOf.set(commit, blob);
    }
    if (blobOf.size === 0)
        return [];
    // Newest first by commit time; fall back to list order if a noted object is not a commit.
    let ordered = [...blobOf.keys()];
    const sorted = await gitWithStdin(repo, ["rev-list", "--no-walk=sorted", "--stdin"], ordered.join("\n") + "\n");
    if (sorted.code === 0)
        ordered = sorted.stdout.toString("utf8").split("\n").filter((sha) => blobOf.has(sha));
    ordered = ordered.slice(0, max);
    const bodies = await gitWithStdin(repo, ["cat-file", "--batch"], ordered.map((c) => blobOf.get(c)).join("\n") + "\n");
    if (bodies.code !== 0) {
        throw new GitError(`git cat-file --batch failed (exit ${bodies.code}): ${bodies.stderr.trim()}`, ["cat-file", "--batch"], bodies.code, "", bodies.stderr);
    }
    const byBlob = parseBatch(bodies.stdout);
    const out = [];
    ordered.forEach((commit, order) => {
        const note = parseLandingNote(byBlob.get(blobOf.get(commit)) ?? "");
        if (note)
            out.push({ commit, note, order });
    });
    // Commit times have one-second resolution; landedAt orders landings within a batch.
    out.sort((a, b) => b.note.landedAt - a.note.landedAt || a.order - b.order);
    return out.map(({ commit, note }) => ({ commit, note }));
}
function haystack(note) {
    return [
        note.taskId,
        note.title ?? "",
        note.summary,
        ...note.contractChanges.map((c) => c.symbol),
        ...note.symbolsChanged.flatMap((s) => s.symbols),
        note.brief ?? "",
    ]
        .join("\n")
        .toLowerCase();
}
/**
 * Case-insensitive substring search over task id, title, summary, changed symbols and brief of the
 * newest MAX_SEARCH_COMMITS landings; newest first, at most `limit` hits. An empty query lists them.
 */
export async function searchNotes(repo, query, limit = DEFAULT_SEARCH_LIMIT) {
    const needle = query.toLowerCase();
    const hits = [];
    for (const entry of await loadNotes(repo)) {
        if (hits.length >= limit)
            break;
        if (needle === "" || haystack(entry.note).includes(needle))
            hits.push(entry);
    }
    return hits;
}
//# sourceMappingURL=notes.js.map