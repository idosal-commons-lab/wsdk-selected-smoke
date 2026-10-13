// One worktree per task: a full clone of the host with a task branch, a fixed git identity, a task marker file,
// and runner-managed files excluded from `git add -A`. The remote `origin` is the host, so both arms can
// `git fetch origin main` and (baseline only) `git push origin HEAD:main`.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { linkNodeModules } from "../bench/rhf/prepare.js";
import { cowCopy } from "../executor/cow.js";
import { git, gitRaw } from "../executor/git.js";
/** Paths the runner writes into a worktree that must never end up in a task commit. */
export const WORKTREE_EXCLUDES = [".commons-task.json", ".mcp.json", "node_modules", ".claude/", "notes/"];
const REMOTE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/\s]+@[^:\s]+:)/i;
/** A git remote as given, or an absolute path when `host` is a local directory. */
export function remoteOf(host) {
    return REMOTE_URL.test(host) ? host : resolve(host);
}
/**
 * Clone `host` into `dir`, create `task/<taskId>` at `baseCommit`, set the identity
 * "Commons Agent <taskId>" / `<taskId>@commons.invalid`, disable commit signing, write
 * `.commons-task.json`, and exclude runner-managed files. Returns the absolute worktree path.
 */
export async function createWorktree(host, dir, baseCommit, taskId, opts = {}) {
    const target = resolve(dir);
    mkdirSync(dirname(target), { recursive: true });
    if (opts.cowFrom) {
        await cowCopy(resolve(opts.cowFrom), target);
        await setOrigin(target, remoteOf(host));
        await git(target, ["fetch", "--quiet", "origin"]);
    }
    else {
        await git(dirname(target), ["clone", "--quiet", remoteOf(host), target]);
    }
    await git(target, ["checkout", "-q", "-b", `task/${taskId}`, baseCommit]);
    await git(target, ["config", "user.name", `Commons Agent ${taskId}`]);
    await git(target, ["config", "user.email", `${taskId}@commons.invalid`]);
    await git(target, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(target, ".commons-task.json"), JSON.stringify({ taskId, ...opts.meta }, null, 2) + "\n");
    excludePaths(target, WORKTREE_EXCLUDES);
    if (opts.nodeModules)
        await linkNodeModules(opts.nodeModules, target);
    return target;
}
/** Point `origin` at `url`, adding the remote when the checkout has none. */
export async function setOrigin(dir, url) {
    const current = await gitRaw(dir, ["remote", "get-url", "origin"]);
    if (current.code === 0)
        await git(dir, ["remote", "set-url", "origin", url]);
    else
        await git(dir, ["remote", "add", "origin", url]);
}
/** Refresh a prefetched, not-yet-started task branch; never call this on a resumed agent's worktree. */
export async function forkFromMain(worktree) {
    await git(worktree, ["fetch", "--quiet", "origin", "main"]);
    const base = await git(worktree, ["rev-parse", "FETCH_HEAD^{commit}"]);
    await git(worktree, ["reset", "--quiet", "--hard", base]);
    return base;
}
/** Append `paths` to `.git/info/exclude` (idempotent). */
export function excludePaths(worktree, paths) {
    const excludePath = join(worktree, ".git", "info", "exclude");
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missing = paths.filter((p) => !present.has(p));
    if (missing.length === 0)
        return;
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(excludePath, `${separator}${missing.join("\n")}\n`);
}
//# sourceMappingURL=worktrees.js.map