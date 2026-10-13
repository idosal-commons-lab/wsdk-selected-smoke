// Thin, hermetic wrapper over the git CLI used by the executor.
//
// Every invocation runs `git -C <cwd> ...` with a sealed environment: no user or
// system gitconfig, no terminal prompts, HOME pinned to the working directory,
// and a fixed committer identity so `commit-tree` never depends on the machine.
import { execFile } from "node:child_process";
export const GIT_IDENTITY = {
    GIT_AUTHOR_NAME: "Commons Integrator",
    GIT_AUTHOR_EMAIL: "integrator@commons.invalid",
    GIT_COMMITTER_NAME: "Commons Integrator",
    GIT_COMMITTER_EMAIL: "integrator@commons.invalid",
};
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
/** Variables passed through from the parent so ssh/https remotes keep working. */
const PASSTHROUGH = ["SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH", "TMPDIR"];
export class GitError extends Error {
    args;
    code;
    stdout;
    stderr;
    constructor(message, args, code, stdout, stderr) {
        super(message);
        this.args = args;
        this.code = code;
        this.stdout = stdout;
        this.stderr = stderr;
        this.name = "GitError";
    }
}
/** The sealed environment every git call runs with. `extra` wins over the defaults. */
export function gitEnv(cwd, extra) {
    const env = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: cwd,
        ...GIT_IDENTITY,
    };
    for (const key of PASSTHROUGH) {
        const value = process.env[key];
        if (value !== undefined)
            env[key] = value;
    }
    return { ...env, ...extra };
}
/** Run git and return the exit code with untrimmed stdout/stderr. Only spawn failures reject. */
export function gitRaw(cwd, args, opts = {}) {
    const fullArgs = ["-C", cwd, ...args];
    return new Promise((resolve, reject) => {
        execFile("git", fullArgs, { env: gitEnv(cwd, opts.env), maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER, encoding: "utf8" }, (error, stdout, stderr) => {
            if (error) {
                const code = error.code;
                if (typeof code === "number") {
                    resolve({ code, stdout, stderr });
                    return;
                }
                reject(new GitError(`git ${args.join(" ")} could not run: ${error.message}`, fullArgs, null, stdout, stderr));
                return;
            }
            resolve({ code: 0, stdout, stderr });
        });
    });
}
/** Run git, throw (with stderr in the message) on a non-zero exit, return trimmed stdout. */
export async function git(cwd, args, opts = {}) {
    const r = await gitRaw(cwd, args, opts);
    if (r.code !== 0) {
        throw new GitError(`git ${args.join(" ")} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, ["-C", cwd, ...args], r.code, r.stdout, r.stderr);
    }
    return r.stdout.trim();
}
/** Whether `git merge-tree --write-tree` accepts `--merge-base` (git >= 2.40). Probed lazily. */
let mergeBaseFlagSupported;
/**
 * Three-way merge of `ours` and `theirs` without touching the index or worktree.
 * Exit 0: clean, returns the merged tree. Exit 1: conflicts, returns the (conflict-marked)
 * tree plus the conflicted paths. Anything else throws.
 */
export async function mergeTree(cwd, base, ours, theirs) {
    const run = (withBase) => gitRaw(cwd, [
        // diff3 markers keep the base section in conflicted blobs, which the pure-insertion resolver needs.
        "-c",
        "merge.conflictStyle=diff3",
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        ...(withBase ? ["--merge-base", base] : []),
        ours,
        theirs,
    ]);
    // Git before 2.40 has no --merge-base. Probed by the first calls, which can run concurrently: any call refused
    // for it retries without, whatever another call concluded meanwhile.
    const withBase = mergeBaseFlagSupported !== false;
    let r = await run(withBase);
    if (withBase && r.code === 129 && /unknown option .merge-base/.test(r.stderr)) {
        mergeBaseFlagSupported = false;
        r = await run(false);
    }
    else if (withBase && mergeBaseFlagSupported === undefined) {
        mergeBaseFlagSupported = true;
    }
    const tokens = r.stdout.split("\0");
    const tree = (tokens[0] ?? "").trim();
    if (r.code === 0) {
        if (!/^[0-9a-f]{40,64}$/.test(tree)) {
            throw new GitError(`merge-tree returned no tree: ${r.stderr.trim()}`, ["merge-tree"], r.code, r.stdout, r.stderr);
        }
        return { tree, conflicts: [] };
    }
    if (r.code !== 1) {
        throw new GitError(`git merge-tree ${ours} ${theirs} failed (exit ${r.code}): ${r.stderr.trim()}`, ["merge-tree"], r.code, r.stdout, r.stderr);
    }
    // Conflicted file section: one path per token until the empty token that ends the section.
    const paths = new Set();
    let i = 1;
    for (; i < tokens.length && tokens[i] !== ""; i++)
        paths.add(tokens[i]);
    // Informational messages follow as groups: <count>\0<path>{count}\0<type>\0<message>\0.
    // Only consulted when the file section was empty (defensive; git lists every conflicted path above).
    if (paths.size === 0) {
        for (let j = i + 1; j < tokens.length;) {
            const count = Number.parseInt(tokens[j] ?? "", 10);
            if (!Number.isFinite(count) || count <= 0)
                break;
            for (let k = 1; k <= count; k++) {
                const p = tokens[j + k];
                if (p)
                    paths.add(p);
            }
            j += count + 3;
        }
    }
    return { tree, conflicts: [...paths].map((path) => ({ path })) };
}
export async function mergeBase(cwd, a, b) {
    return git(cwd, ["merge-base", a, b]);
}
/** True when `ancestor` is reachable from `descendant` (or equal to it). */
export async function isAncestor(cwd, ancestor, descendant) {
    const r = await gitRaw(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    if (r.code === 0)
        return true;
    if (r.code === 1)
        return false;
    throw new GitError(`git merge-base --is-ancestor ${ancestor} ${descendant} failed (exit ${r.code}): ${r.stderr.trim()}`, ["merge-base", "--is-ancestor", ancestor, descendant], r.code, r.stdout, r.stderr);
}
export async function hasCommit(cwd, commit) {
    const r = await gitRaw(cwd, ["cat-file", "-e", `${commit}^{commit}`]);
    return r.code === 0;
}
export async function treeOf(cwd, commit) {
    return git(cwd, ["rev-parse", "--verify", `${commit}^{tree}`]);
}
export async function commitTree(cwd, tree, parents, message) {
    const args = ["commit-tree", tree];
    for (const p of parents)
        args.push("-p", p);
    args.push("-m", message);
    return git(cwd, args);
}
/** Files that differ between two commits. Renames are reported as D + A. */
export async function changedFiles(cwd, from, to) {
    const r = await gitRaw(cwd, ["diff", "--name-status", "--no-renames", "-z", from, to]);
    if (r.code !== 0) {
        throw new GitError(`git diff ${from} ${to} failed (exit ${r.code}): ${r.stderr.trim()}`, ["diff", from, to], r.code, r.stdout, r.stderr);
    }
    const tokens = r.stdout.split("\0");
    const out = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
        const raw = tokens[i];
        const path = tokens[i + 1];
        if (!raw || !path)
            continue;
        const letter = raw[0];
        const status = letter === "A" ? "A" : letter === "D" ? "D" : "M";
        out.push({ path, status });
    }
    return out;
}
const MISSING_PATH = /does not exist in|exists on disk, but not in|Not a valid object name|invalid object name|bad revision|unknown revision/i;
/** Contents of `path` at `commit`, or null when the file is absent there. */
export async function showFile(cwd, commit, path) {
    const r = await gitRaw(cwd, ["show", `${commit}:${path}`]);
    if (r.code === 0)
        return r.stdout;
    if (MISSING_PATH.test(r.stderr))
        return null;
    throw new GitError(`git show ${commit}:${path} failed (exit ${r.code}): ${r.stderr.trim()}`, ["show", `${commit}:${path}`], r.code, r.stdout, r.stderr);
}
//# sourceMappingURL=git.js.map