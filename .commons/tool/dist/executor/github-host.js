import { git, GitError, isAncestor } from "./git.js";
import { HOST_MAIN_REF } from "./host.js";
import { GITHUB_TASK_REF_PREFIX, taskRefFor, validRef } from "./task-ref.js";
/** Accept repository HTTPS URLs only; credentials must never become part of git's argv. */
export function parseGitHubUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error("invalid GitHub repository URL: expected https://<host>/<owner>/<repo>");
    }
    const parts = /^\/([\w.-]+)\/([\w.-]+)\/?$/.exec(parsed.pathname);
    const repo = parts?.[2]?.replace(/\.git$/, "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        !parts || !repo || parts[1] === "." || parts[1] === ".." || repo === "." || repo === "..") {
        throw new Error("invalid GitHub repository URL: expected credential-free https://<host>/<owner>/<repo>");
    }
    return {
        owner: parts[1], repo, origin: parsed.origin,
        apiBase: parsed.hostname === "github.com" ? "https://api.github.com" : `${parsed.origin}/api/v3`,
    };
}
/** Origin-scoped authentication passed only through the environment, never -c or URL credentials. */
export function githubGitEnv(url, token) {
    if (!token || !/^https:\/\//i.test(url))
        return {};
    const { origin } = parseGitHubUrl(url);
    return {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
}
/** Pure command builder so callers and tests can inspect the argv/environment boundary. */
export function githubGitCommand(url, token, args) {
    return { args: [...args], env: githubGitEnv(url, token) };
}
export class GitHubHost {
    url;
    owner;
    repo;
    token;
    apiBase;
    mainBranch;
    taskRefPrefix;
    gitEnv;
    statusTimeoutMs;
    knownMain;
    constructor(url, opts = {}) {
        this.url = url;
        // Local fixtures are opt-in. Any network URL still goes through HTTPS repository validation.
        const local = opts.kind === "github" && (/^file:\/\//i.test(url) ||
            !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^[^/\\:]+@[^/\\:]+:/.test(url));
        const repository = local ? undefined : parseGitHubUrl(url);
        this.owner = repository?.owner;
        this.repo = repository?.repo;
        this.token = opts.token ?? process.env.COMMONS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
        this.apiBase = (opts.apiBase ?? process.env.COMMONS_GITHUB_API_BASE ?? repository?.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
        const api = new URL(this.apiBase);
        if (!["https:", "http:"].includes(api.protocol) || api.username || api.password || api.search || api.hash) {
            throw new Error("invalid GitHub API base URL");
        }
        this.mainBranch = opts.mainBranch ?? process.env.COMMONS_MAIN_BRANCH ?? "main";
        if (this.mainBranch.startsWith("-") || !validRef(`refs/heads/${this.mainBranch}`))
            throw new Error("invalid GitHub main branch");
        this.taskRefPrefix = opts.taskRefPrefix ?? process.env.COMMONS_TASK_REF_PREFIX ?? GITHUB_TASK_REF_PREFIX;
        if (!this.taskRefPrefix.endsWith("/") || !validRef(taskRefFor(this.taskRefPrefix, "validation"))) {
            throw new Error("invalid GitHub task ref prefix");
        }
        this.gitEnv = githubGitEnv(url, this.token);
        this.knownMain = opts.knownMain;
        const timeout = opts.statusTimeoutMs ?? 5000;
        if (!Number.isInteger(timeout) || timeout <= 0)
            throw new Error("invalid GitHub status timeout");
        this.statusTimeoutMs = Math.min(timeout, 5000);
    }
    taskRef(taskId) {
        return taskRefFor(this.taskRefPrefix, taskId);
    }
    run(work, args) {
        const command = githubGitCommand(this.url, this.token, args);
        return git(work, command.args, { env: command.env });
    }
    async fetchTask(work, taskId) {
        const ref = this.taskRef(taskId);
        await this.run(work, ["fetch", "--quiet", this.url, `+${ref}:${ref}`]);
        return git(work, ["rev-parse", "--verify", `${ref}^{commit}`]);
    }
    async fetchMain(work) {
        await this.run(work, ["fetch", "--quiet", this.url, `+refs/heads/${this.mainBranch}:${HOST_MAIN_REF}`]);
        this.knownMain = await git(work, ["rev-parse", "--verify", `${HOST_MAIN_REF}^{commit}`]);
        return this.knownMain;
    }
    async pushMain(work, commit) {
        try {
            const expected = this.knownMain ?? (await this.fetchMain(work));
            if (expected !== commit && !(await isAncestor(work, expected, commit))) {
                throw new Error(`pushMain: ${commit} is not a fast-forward of ${this.mainBranch} ${expected} on ${this.url}`);
            }
            const ref = `refs/heads/${this.mainBranch}`;
            await this.run(work, ["push", "--quiet", this.url, `--force-with-lease=${ref}:${expected}`, `${commit}:${ref}`]);
            this.knownMain = commit;
            await git(work, ["update-ref", HOST_MAIN_REF, commit]);
        }
        catch (error) {
            this.knownMain = undefined;
            if (error instanceof GitError && /protected branch|GH006/i.test(error.stderr)) {
                throw new Error(`GitHub rejected the push to ${this.mainBranch}: allow the integrator's token to bypass branch protection or use a non-protected integration branch (COMMONS_MAIN_BRANCH).`, { cause: error });
            }
            throw error;
        }
    }
    /** Status failures are data: the integration loop must never depend on the API being available. */
    async reportStatus(sha, state, description, context = "commons/verify", targetUrl) {
        if (!this.token)
            return { ok: false, error: "GitHub token is not configured" };
        if (!this.owner || !this.repo)
            return { ok: false, error: "local GitHub fixture has no API repository identity" };
        try {
            const response = await fetch(`${this.apiBase}/repos/${this.owner}/${this.repo}/statuses/${encodeURIComponent(sha)}`, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(this.statusTimeoutMs),
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ state, description: Array.from(description).slice(0, 140).join(""), context, ...(targetUrl ? { target_url: targetUrl } : {}) }),
            });
            // Reading the body stays under the same abort deadline, even if only headers arrive.
            await response.text();
            return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `GitHub status API: ${response.status} ${response.statusText}` };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}
/** Remember leased submission SHAs; preserve coordinator behavior and detach bounded status requests. */
export function withCommitStatuses(client, host, log) {
    const batches = new Map();
    // Optimistic landings awaiting their combined check: submission id -> commit.
    const settled = new Map();
    const key = (repoId, batchId) => JSON.stringify([repoId, batchId]);
    const warn = (sha, error) => {
        try {
            log(`[github status ${sha}] ${error}`);
        }
        catch { /* A diagnostic sink cannot break integration. */ }
    };
    return {
        ...(client.landings && { landings: client.landings.bind(client) }),
        ...(client.renewLease && { renewLease: client.renewLease.bind(client) }),
        ...(client.setCandidate && { setCandidate: client.setCandidate.bind(client) }),
        ...(client.leaseState && { leaseState: client.leaseState.bind(client) }),
        ...(client.settle && {
            // An optimistic landing's combined check settles it: the commit's status follows (verified, or reverted).
            settle: async (repoId, s) => {
                await client.settle(repoId, s);
                const sha = settled.get(s.submissionId);
                if (!sha)
                    return;
                settled.delete(s.submissionId);
                const passed = s.outcome === "verified";
                const description = passed ? "Landed and verified" : `Reverted after landing: ${s.verdict.failedTests.slice(0, 3).join(", ") || s.verdict.excerpt.replace(/\s+/g, " ").trim()}`;
                void host.reportStatus(sha, passed ? "success" : "failure", description)
                    .then((status) => { if (!status.ok)
                    warn(sha, status.error ?? `HTTP ${status.status}`); })
                    .catch((error) => warn(sha, error instanceof Error ? error.message : String(error)));
            },
        }),
        lease: async (...args) => {
            const lease = await client.lease(...args);
            if (lease)
                batches.set(key(args[0], lease.batchId), new Map(lease.submissions.map((s) => [s.id, s.commit])));
            return lease;
        },
        report: async (repoId, result) => {
            const batchKey = key(repoId, result.batchId);
            const commits = batches.get(batchKey);
            try {
                await client.report(repoId, result);
            }
            finally {
                batches.delete(batchKey);
            }
            for (const item of result.results) {
                const sha = commits?.get(item.submissionId);
                if (!sha) {
                    warn(item.submissionId, "no leased submission commit for verdict");
                    continue;
                }
                if (item.status === "landed" && item.verdict.optimistic && !item.verdict.verified) {
                    settled.set(item.submissionId, sha);
                    void host.reportStatus(sha, "pending", "Landed; verifying on main (optimistic landing)")
                        .then((status) => { if (!status.ok)
                        warn(sha, status.error ?? `HTTP ${status.status}`); })
                        .catch((error) => warn(sha, error instanceof Error ? error.message : String(error)));
                    continue;
                }
                const passed = item.status === "landed" || item.verdict.passed;
                const description = passed ? (item.status === "landed" ? "Landed and verified" : "Verification passed") :
                    item.verdict.excerpt.replace(/\s+/g, " ").trim() ||
                        (item.verdict.failedTests.length ? `Failed tests: ${item.verdict.failedTests.join(", ")}` :
                            item.verdict.conflicts.length ? `Merge conflicts: ${item.verdict.conflicts.map((c) => c.path).join(", ")}` : "Verification failed");
                void host.reportStatus(sha, passed ? "success" : "failure", description)
                    .then((status) => { if (!status.ok)
                    warn(sha, status.error ?? `HTTP ${status.status}`); })
                    .catch((error) => warn(sha, error instanceof Error ? error.message : String(error)));
            }
        },
    };
}
//# sourceMappingURL=github-host.js.map