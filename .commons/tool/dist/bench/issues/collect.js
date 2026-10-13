// Collect an "issues" workload from a GitHub repository: merged pull requests that closed an issue and changed both
// source and tests. A window of such PRs becomes N concurrent tasks on one base commit (the parent of the earliest
// merge), each task's text is its issue, and its hidden tests are the PR's test files at the merge commit.
// Needs the `gh` CLI (authenticated). No clone is required to collect; validation and runs need one.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
const run = promisify(execFile);
export const TEST_PATH = /(^|\/)(__tests__|tests?|e2e|__snapshots__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
export const GENERATED_PATH = /^\.changeset\/|(^|\/)pnpm-lock\.yaml$|(^|\/)package-lock\.json$|(^|\/)CHANGELOG\.md$/;
export function isTestPath(path) {
    return TEST_PATH.test(path);
}
/** `packages/<name>` or `fixtures/<name>` for a monorepo path, else the first path segment. */
export function packageOf(path) {
    const m = /^(packages|fixtures|apps)\/([^/]+)\//.exec(path);
    return m ? `${m[1]}/${m[2]}` : path.split("/")[0];
}
export const DEFAULT_LIMITS = { maxFiles: 25, maxLines: 1500, packagesOnly: true };
/** Why a PR cannot be a task, or null when it can. */
export function rejectReason(pr, limits = DEFAULT_LIMITS) {
    if (pr.baseRefName !== "main")
        return `base ${pr.baseRefName}`;
    if (pr.issues.length === 0)
        return "no closing issue";
    const src = pr.files.filter((f) => !isTestPath(f.path) && !GENERATED_PATH.test(f.path));
    const tests = pr.files.filter((f) => isTestPath(f.path));
    if (tests.length === 0)
        return "no test changes";
    if (src.length === 0)
        return "no source changes";
    if (pr.changedFiles > limits.maxFiles)
        return `${pr.changedFiles} files`;
    if (pr.additions + pr.deletions > limits.maxLines)
        return `${pr.additions + pr.deletions} lines`;
    if (limits.packagesOnly && !src.every((f) => f.path.startsWith("packages/")))
        return "source outside packages/";
    if (pr.files.length >= 60)
        return "file list truncated";
    return null;
}
/**
 * Oldest-first greedy selection of up to `max` candidates whose test files are pairwise disjoint (each hidden test
 * must score one task) within the most recent `max`-sized stretch; returns them oldest first.
 */
export function selectWindow(candidates, max) {
    const newestFirst = [...candidates].sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));
    const chosen = [];
    const seenTests = new Set();
    for (const pr of newestFirst) {
        if (chosen.length >= max)
            break;
        const tests = pr.files.filter((f) => isTestPath(f.path)).map((f) => f.path);
        if (tests.some((t) => seenTests.has(t)))
            continue;
        for (const t of tests)
            seenTests.add(t);
        chosen.push(pr);
    }
    return chosen.sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : 1));
}
export function taskBodyFor(task) {
    return [
        `Issue #${task.issue.number}: ${task.issue.title}`,
        "",
        task.issue.body.trim() || "(no description)",
        "",
        `Fix this in the \`${task.package}\` package of this monorepo. Add or extend tests in that package's existing test style so the fix is covered. Keep the change focused on the issue.`,
    ].join("\n");
}
// ---- GitHub access -----------------------------------------------------------
const QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:MERGED, first:50, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{ number title mergedAt baseRefName mergeCommit{oid} additions deletions changedFiles
        closingIssuesReferences(first:3){nodes{number title}}
        files(first:60){nodes{path additions deletions}} }
    }
  }
}`;
async function gh(args) {
    const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}
export async function fetchMergedPrs(owner, name, pages, log) {
    const out = [];
    let after = null;
    for (let i = 0; i < pages; i++) {
        const args = ["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-f", `query=${QUERY}`];
        if (after)
            args.push("-F", `after=${after}`);
        const data = JSON.parse(await gh(args));
        const page = data.data.repository.pullRequests;
        for (const n of page.nodes) {
            if (!n.mergeCommit)
                continue;
            out.push({ number: n.number, title: n.title, mergedAt: n.mergedAt, baseRefName: n.baseRefName, mergeCommit: n.mergeCommit.oid, additions: n.additions, deletions: n.deletions, changedFiles: n.changedFiles, issues: n.closingIssuesReferences.nodes, files: n.files.nodes });
        }
        log(`page ${i + 1}: ${out.length} merged PRs so far`);
        if (!page.pageInfo.hasNextPage)
            break;
        after = page.pageInfo.endCursor;
    }
    return out;
}
async function issueBody(owner, name, number) {
    const j = JSON.parse(await gh(["api", `repos/${owner}/${name}/issues/${number}`]));
    return { title: j.title, body: j.body ?? "" };
}
async function fileAt(owner, name, path, ref) {
    const j = JSON.parse(await gh(["api", `repos/${owner}/${name}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${ref}`]));
    if (!j.content)
        throw new Error(`no content for ${path}@${ref}`);
    return Buffer.from(j.content, "base64").toString("utf8");
}
async function firstParent(owner, name, sha) {
    const j = JSON.parse(await gh(["api", `repos/${owner}/${name}/commits/${sha}`]));
    if (!j.parents?.length)
        throw new Error(`${sha} has no parent`);
    return j.parents[0].sha;
}
export async function collectIssues(o) {
    const log = o.log ?? ((l) => console.error(`[issues] ${l}`));
    const [owner, name] = o.repo.split("/");
    if (!owner || !name)
        throw new Error(`--repo must be owner/name, got ${o.repo}`);
    const prs = await fetchMergedPrs(owner, name, o.pages, log);
    const limits = o.limits ?? DEFAULT_LIMITS;
    const reasons = new Map();
    const candidates = [];
    for (const pr of prs) {
        // A window that ends by `until` (a base the local toolchain can install, for example).
        if (o.until && pr.mergedAt > o.until)
            continue;
        const why = rejectReason(pr, limits);
        if (why)
            reasons.set(why, (reasons.get(why) ?? 0) + 1);
        else
            candidates.push(pr);
    }
    log(`${candidates.length} candidates of ${prs.length}; rejected: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`);
    const window = selectWindow(candidates, o.max);
    if (window.length === 0)
        throw new Error("no candidates");
    const baseCommit = await firstParent(owner, name, window[0].mergeCommit);
    const tasks = [];
    for (const pr of window) {
        // A closing reference can name an issue of another repository; the first one this repository has is the task.
        let found = null;
        for (const issue of pr.issues) {
            try {
                found = { issue, ...(await issueBody(owner, name, issue.number)) };
                break;
            }
            catch {
                log(`#${pr.number}: issue #${issue.number} is not in ${o.repo}`);
            }
        }
        if (!found)
            continue;
        const { issue, title, body } = found;
        const testFiles = [];
        for (const f of pr.files.filter((x) => isTestPath(x.path))) {
            try {
                testFiles.push({ path: f.path, content: await fileAt(owner, name, f.path, pr.mergeCommit) });
            }
            catch (error) {
                log(`#${pr.number}: skipping ${f.path} (${error.message.split("\n")[0]})`);
            }
        }
        const srcFiles = pr.files.filter((x) => !isTestPath(x.path) && !GENERATED_PATH.test(x.path)).map((x) => x.path);
        const pkg = packageOf(srcFiles[0]);
        tasks.push({ id: `pr${pr.number}`, package: pkg, issue: { number: issue.number, title, body }, pr: { number: pr.number, title: pr.title, mergeCommit: pr.mergeCommit, mergedAt: pr.mergedAt }, testFiles, srcFiles });
        log(`#${pr.number} (${pkg}): issue #${issue.number} "${title.slice(0, 60)}", ${testFiles.length} hidden test file(s)`);
    }
    const set = { repo: o.repo, collectedAt: new Date().toISOString(), baseCommit, windowStart: window[0].mergedAt, windowEnd: window.at(-1).mergedAt, tasks };
    await mkdir(dirname(resolve(o.out)), { recursive: true });
    await writeFile(o.out, JSON.stringify(set, null, 2) + "\n");
    log(`wrote ${o.out}: ${tasks.length} tasks on base ${baseCommit.slice(0, 12)} (${set.windowStart.slice(0, 10)} .. ${set.windowEnd.slice(0, 10)})`);
    return set;
}
export async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: { repo: { type: "string" }, max: { type: "string", default: "32" }, pages: { type: "string", default: "4" }, out: { type: "string" }, until: { type: "string" }, "max-files": { type: "string" }, "max-lines": { type: "string" }, "any-path": { type: "boolean", default: false } },
    });
    if (!values.repo)
        throw new Error("--repo owner/name is required");
    const name = values.repo.split("/")[1];
    const limits = { ...DEFAULT_LIMITS, ...(values["max-files"] ? { maxFiles: Number(values["max-files"]) } : {}), ...(values["max-lines"] ? { maxLines: Number(values["max-lines"]) } : {}), packagesOnly: !values["any-path"] };
    await collectIssues({ repo: values.repo, max: Number(values.max), pages: Number(values.pages), out: values.out ?? resolve(`bench/issues/${name}.json`), limits, ...(values.until ? { until: values.until } : {}) });
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=collect.js.map