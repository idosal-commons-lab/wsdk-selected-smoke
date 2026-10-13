// Git host abstraction: where task refs come from and where main is pushed.
//
// `LocalBareHost` uses plain git (a bare repository on disk, or a git URL).
// `GitHubHost` adds token authentication, visible task branches and commit statuses.
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cowCopy } from "./cow.js";
import { git, gitRaw, isAncestor } from "./git.js";
import { GitHubHost } from "./github-host.js";
import { LOCAL_TASK_REF_PREFIX, taskRefFor } from "./task-ref.js";
/** Local tracking ref the executor keeps for the host's main. */
export const HOST_MAIN_REF = "refs/remotes/commons/main";
export class LocalBareHost {
    url;
    /** Last value of the host's main this process observed (after init, fetchMain or pushMain). */
    knownMain;
    constructor(url, knownMain) {
        this.url = url;
        this.knownMain = knownMain;
    }
    /** Create a bare repository at `path` cloned from `fromRepo` with main set to `baseCommit`. */
    static async init(path, fromRepo, baseCommit) {
        const target = resolve(path);
        mkdirSync(dirname(target), { recursive: true });
        await git(dirname(target), ["clone", "--bare", "--quiet", resolve(fromRepo), target]);
        await git(target, ["update-ref", "refs/heads/main", baseCommit]);
        await git(target, ["symbolic-ref", "HEAD", "refs/heads/main"]);
        return new LocalBareHost(path, await git(target, ["rev-parse", "--verify", "refs/heads/main^{commit}"]));
    }
    async fetchTask(work, taskId) {
        const ref = this.taskRef(taskId);
        await git(work, ["fetch", "--quiet", this.url, `+${ref}:${ref}`]);
        return git(work, ["rev-parse", "--verify", `${ref}^{commit}`]);
    }
    taskRef(taskId) {
        return taskRefFor(LOCAL_TASK_REF_PREFIX, taskId);
    }
    async fetchMain(work) {
        await git(work, ["fetch", "--quiet", this.url, `+refs/heads/main:${HOST_MAIN_REF}`]);
        this.knownMain = await git(work, ["rev-parse", "--verify", `${HOST_MAIN_REF}^{commit}`]);
        return this.knownMain;
    }
    /**
     * Push `commit` to the host's main with `--force-with-lease` against the last known main.
     * Refuses non-fast-forward updates so a stale lease can never rewind main.
     */
    async pushMain(work, commit) {
        const expected = this.knownMain ?? (await this.fetchMain(work));
        if (expected !== commit && !(await isAncestor(work, expected, commit))) {
            throw new Error(`pushMain: ${commit} is not a fast-forward of main ${expected} on ${this.url}`);
        }
        try {
            await git(work, [
                "push",
                "--quiet",
                this.url,
                `--force-with-lease=refs/heads/main:${expected}`,
                `${commit}:refs/heads/main`,
            ]);
        }
        catch (error) {
            // The lease was stale or the push failed: forget what we knew so the next call re-learns it.
            this.knownMain = undefined;
            throw error;
        }
        this.knownMain = commit;
        await git(work, ["update-ref", HOST_MAIN_REF, commit]);
    }
}
/** Select GitHub automatically for github.com, or explicitly for Enterprise/local fixtures. */
export function hostFor(url, opts = {}) {
    let hostname;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "file:")
            hostname = parsed.hostname;
    }
    catch { /* Filesystem path or scp-style git URL. */ }
    if (opts.kind === "github" || process.env.COMMONS_HOST_KIND === "github" || hostname === "github.com") {
        return new GitHubHost(url, { ...opts, kind: "github" });
    }
    return new LocalBareHost(url, opts.knownMain);
}
/** Clone the host into `work` if there is no repository there yet. */
export async function ensureWorkClone(work, host, cowFrom) {
    const target = resolve(work);
    if (existsSync(join(target, ".git")))
        return;
    mkdirSync(dirname(target), { recursive: true });
    if (cowFrom) {
        // A prepared checkout cloned copy-on-write: seconds instead of a clone plus an install, blocks shared.
        await cowCopy(resolve(cowFrom), target);
        const current = await gitRaw(target, ["remote", "get-url", "origin"]);
        await git(target, current.code === 0 ? ["remote", "set-url", "origin", host.url] : ["remote", "add", "origin", host.url]);
        await git(target, ["fetch", "--quiet", "origin"], { env: host.gitEnv });
        return;
    }
    await git(dirname(target), ["clone", "--quiet", host.url, basename(target)], { env: host.gitEnv });
}
//# sourceMappingURL=host.js.map