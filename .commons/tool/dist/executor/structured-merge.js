// Structured fallbacks for textual merge conflicts: TypeScript/JavaScript and Python replay first, then Mergiraf
// (https://mergiraf.org) when it is on PATH, then pure-insertion concatenation.
// A resolved file is only a candidate: the executor still runs the checks on the combined tree, so a wrong
// structured merge is caught by tests instead of by an agent.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { git, gitRaw, showFile } from "./git.js";
import { REPLAY_EXTENSIONS, replayMerge } from "./replay.js";
import { PY_REPLAY_EXTENSIONS, pythonAvailable, replayMergePython } from "./replay-python.js";
const run = promisify(execFile);
let cachedAvailability;
/** True when the `mergiraf` binary runs. Cached per process. */
export function mergirafAvailable() {
    if (!cachedAvailability) {
        cachedAvailability = run("mergiraf", ["--version"], { timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
    }
    return cachedAvailability;
}
/**
 * Try structural replay, Mergiraf, and insertion concatenation for a `git merge-tree` result. Returns the resolved tree
 * (built from `conflictedTree`, which already contains the clean auto-merged paths) or null when any file
 * stays conflicted, was added/removed on one side, or has an unsupported language.
 */
export async function structuredMerge(work, base, ours, theirs, conflictedTree, conflicts, opts = {}) {
    if (conflicts.length === 0)
        return null;
    const scratch = await mkdtemp(join(tmpdir(), "commons-mergiraf-"));
    try {
        const resolutions = [];
        const by = {};
        for (const { path } of conflicts) {
            const [b, o, t] = await Promise.all([showFile(work, base, path), showFile(work, ours, path), showFile(work, theirs, path)]);
            if (b === null || o === null || t === null)
                return null; // add/add or modify/delete: leave it to the agent
            const name = basename(path);
            const files = [join(scratch, `base-${name}`), join(scratch, `ours-${name}`), join(scratch, `theirs-${name}`)];
            await Promise.all([writeFile(files[0], b), writeFile(files[1], o), writeFile(files[2], t)]);
            let merged = null;
            if (opts.replay !== false) {
                const replayed = REPLAY_EXTENSIONS.test(path)
                    ? replayMerge(path, b, o, t)
                    : PY_REPLAY_EXTENSIONS.test(path) && (await pythonAvailable())
                        ? await replayMergePython(path, b, o, t, { timeoutMs: opts.timeoutMs })
                        : null;
                if (replayed?.ok) {
                    merged = replayed.content;
                    by[path] = "replay";
                }
            }
            if (merged === null && opts.mergiraf !== false && (await mergirafAvailable())) {
                try {
                    const r = await run("mergiraf", ["merge", ...files, "-p", path, "-t", String(opts.timeoutMs ?? 10_000)], {
                        maxBuffer: 64 * 1024 * 1024,
                        timeout: (opts.timeoutMs ?? 10_000) + 5_000,
                    });
                    merged = r.stdout;
                    by[path] = "mergiraf";
                }
                catch {
                    merged = null; // exit 1 = conflicts remain (or unsupported language)
                }
            }
            if (merged === null && opts.concatInsertions !== false) {
                const conflicted = await showFile(work, conflictedTree, path);
                merged = conflicted === null ? null : concatPureInsertions(conflicted);
                if (merged !== null)
                    by[path] = "concat";
            }
            if (merged === null)
                return null;
            resolutions.push({ path, content: merged });
        }
        return { ...(await buildResolvedTree(work, conflictedTree, ours, resolutions)), by };
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
/**
 * Build a tree from `conflictedTree` (which already holds every cleanly merged path) with the given paths
 * replaced by resolved contents. File modes come from `modeFrom`.
 */
export async function buildResolvedTree(work, conflictedTree, modeFrom, resolutions) {
    const scratch = await mkdtemp(join(tmpdir(), "commons-resolve-"));
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
        await git(work, ["read-tree", conflictedTree], { env });
        const resolved = [];
        for (const { path, content } of resolutions) {
            const out = join(scratch, `merged-${basename(path)}`);
            await writeFile(out, content);
            const blob = (await git(work, ["hash-object", "-w", out])).trim();
            const mode = await modeOf(work, modeFrom, path);
            await git(work, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`], { env });
            resolved.push(path);
        }
        const tree = (await git(work, ["write-tree"], { env })).trim();
        return { tree, resolved };
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
const CONFLICT_BLOCK = /^<{7}[^\n]*\n([\s\S]*?)^\|{7}[^\n]*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}[^\n]*\n?/gm;
/**
 * Resolve a diff3-marked file whose every conflict is a pure insertion on both sides (the base section is
 * empty) by keeping both insertions, ours first. Typical cases: two agents appending test cases, interface
 * members, or object fields at the same spot. Returns null when any conflict modifies existing lines, or
 * when the file has no diff3 markers at all.
 */
export function concatPureInsertions(content) {
    if (!content.includes("<<<<<<<") || !content.includes("|||||||"))
        return null;
    let resolvedAny = false;
    let failed = false;
    const out = content.replace(CONFLICT_BLOCK, (_m, ours, base, theirs) => {
        if (base.length > 0) {
            failed = true;
            return _m;
        }
        resolvedAny = true;
        return ours + theirs;
    });
    if (failed || !resolvedAny || out.includes("<<<<<<<") || out.includes(">>>>>>>"))
        return null;
    return out;
}
async function modeOf(work, commit, path) {
    const r = await gitRaw(work, ["ls-tree", commit, "--", path]);
    const match = /^(\d{6})\s/.exec(r.stdout);
    return match ? match[1] : "100644";
}
//# sourceMappingURL=structured-merge.js.map