// Replay a recorded trace (src/bench/replay/trace.ts) through GitHub the way agents on GitHub work today: each task a
// branch and a pull request with auto-merge, CI on the pull request, then GitHub's merge queue (CI again on the merge
// group) in front of main. Same work, same think times, same concurrency as a local replay through Commons, so the two
// can be compared on time to land, CI minutes and main's health.
//
//   node --import tsx src/bench/lab/replay.ts --repo <org>/<name> --trace <dir> --set bench/issues/<repo>.json \
//     --agents N [--scale F] [--arrival-ms N] --out <dir>
//
// The lab repository comes from src/bench/lab/github.ts. Everything here acts on it through gh as its logged-in user.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { benchRoot } from "../issues/prepare.js";
import { githubGitEnv } from "../../executor/github-host.js";
import { useTraceObjects } from "../../runner/fake-agent.js";
const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 20_000;
const LAND_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const RETRIES = 1; // replays of the last recorded change after it fails where the recorded run landed it
async function gh(args) {
    return (await run("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
}
async function git(cwd, args, env = {}) {
    try {
        const r = await run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
        return { code: 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
    }
    catch (error) {
        const e = error;
        return { code: typeof e.code === "number" ? e.code : 1, stdout: (e.stdout ?? "").trim(), stderr: (e.stderr ?? "").trim() };
    }
}
async function must(cwd, args, env = {}) {
    const r = await git(cwd, args, env);
    if (r.code !== 0)
        throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
}
const PR_STATE = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      state merged mergedAt mergeable isInMergeQueue headRefOid
      mergeCommit { oid }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      timelineItems(last: 10, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { ... on RemovedFromMergeQueueEvent { createdAt reason } } }
    }
  }
}`;
/** What became of the pull request's current head since it was submitted at `since`. */
export function outcomeOf(pr, head, since) {
    if (pr.merged)
        return { kind: "merged", at: Date.parse(pr.mergedAt), commit: pr.mergeCommit?.oid ?? "" };
    const removed = pr.timelineItems.nodes.find((n) => Date.parse(n.createdAt) >= since);
    if (removed)
        return { kind: "failed", why: `removed from the merge queue: ${removed.reason}` };
    const last = pr.commits.nodes[0]?.commit;
    if (last?.oid === head && (last.statusCheckRollup?.state === "FAILURE" || last.statusCheckRollup?.state === "ERROR"))
        return { kind: "failed", why: "pull request CI failed" };
    if (pr.mergeable === "CONFLICTING")
        return { kind: "conflict" };
    return null;
}
export async function replayOnGitHub(o) {
    const [owner, name] = o.repo.split("/");
    const url = `https://github.com/${o.repo}.git`;
    const token = await gh(["auth", "token"]);
    const auth = githubGitEnv(url, token);
    const identity = (id) => ({ ...auth, GIT_AUTHOR_NAME: `Agent ${id}`, GIT_AUTHOR_EMAIL: `${id}@commons.invalid`, GIT_COMMITTER_NAME: `Agent ${id}`, GIT_COMMITTER_EMAIL: `${id}@commons.invalid` });
    // One local clone sharing the prepared base's objects (only the lab's CI commit comes over the network), and a git
    // worktree per task: no dependencies are installed, the checks run on GitHub.
    const shared = join(o.out, "shared");
    if (!existsSync(join(shared, ".git")))
        await must(o.out, ["clone", "--quiet", "--shared", "--no-checkout", o.baseDir, shared]);
    await git(shared, ["remote", "remove", "lab"]);
    await must(shared, ["remote", "add", "lab", url]);
    await must(shared, ["fetch", "--quiet", "lab", "main"], auth);
    await useTraceObjects(shared, o.trace.objects);
    // Git operations on the shared clone's refs and worktrees (fetch, worktree add and remove, push) one at a time: run
    // together, a fetch's connectivity check reads a worktree that another task is still creating ("bad object").
    let gitLock = Promise.resolve();
    const serial = (fn) => {
        const next = gitLock.then(fn, fn);
        gitLock = next.catch(() => undefined);
        return next;
    };
    const ids = Object.keys(o.trace.tasks).filter((id) => !o.only || o.only.includes(id));
    const logs = ids.map((id) => ({ id, submits: [], outcomes: [], result: "not started" }));
    const startedAt = Date.now();
    let free = o.agents;
    const waiters = [];
    const acquire = async () => {
        while (free === 0)
            await new Promise((r) => waiters.push(r));
        free--;
    };
    const release = () => {
        free++;
        waiters.shift()?.();
    };
    const prState = async (n) => JSON.parse(await gh(["api", "graphql", "-f", `query=${PR_STATE}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${n}`])).data.repository.pullRequest;
    const waitFor = async (n, head, since) => {
        const deadline = since + LAND_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(POLL_MS);
            try {
                const outcome = outcomeOf(await prState(n), head, since);
                if (outcome)
                    return outcome;
            }
            catch (error) {
                o.log(`poll #${n}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return { kind: "timeout" };
    };
    const replayTask = async (index) => {
        const id = ids[index];
        const task = o.trace.tasks[id];
        const entry = logs[index];
        const arrival = startedAt + index * o.arrivalMs;
        if (arrival > Date.now())
            await sleep(arrival - Date.now());
        await acquire();
        let held = true;
        try {
            entry.startedAt = Date.now();
            const wt = join(o.out, "worktrees", id);
            const branch = `agent/${id}`;
            await serial(async () => {
                await must(shared, ["fetch", "--quiet", "lab", "main"], auth);
                await must(shared, ["worktree", "add", "--quiet", "-B", branch, wt, "lab/main"]);
            });
            const recorded = task.attempts.length;
            let pr;
            entry.result = "never submitted in the recorded run";
            for (let attempt = 0; recorded > 0 && attempt < recorded + RETRIES; attempt++) {
                const a = task.attempts[Math.min(attempt, recorded - 1)];
                if (attempt < recorded)
                    await sleep(a.thinkMs * o.scale);
                if (attempt > 0) {
                    await serial(() => must(wt, ["fetch", "--quiet", "lab", "main"], auth));
                    await must(wt, ["reset", "--quiet", "--hard", "lab/main"]);
                }
                const applied = await git(wt, ["apply", "--3way", "--whitespace=nowarn", resolve(o.traceDir, a.patch)]);
                if (applied.code !== 0) {
                    entry.result = `the recorded change does not apply: ${applied.stderr.split("\n")[0]}`;
                    break;
                }
                await must(wt, ["add", "-A"]);
                await must(wt, ["commit", "--quiet", "-m", `${id}: replayed submission ${attempt + 1}`], identity(id));
                const head = await must(wt, ["rev-parse", "HEAD"]);
                await serial(() => must(wt, ["push", "--quiet", "--force", "lab", `HEAD:refs/heads/${branch}`], auth));
                const since = Date.now();
                entry.submits.push({ at: since, sha: head });
                if (pr === undefined) {
                    const created = await gh(["pr", "create", "--repo", o.repo, "--base", "main", "--head", branch, "--title", `${id}: replayed`, "--body", `Replay of ${id} from ${o.trace.source}.`]);
                    pr = Number(/\/pull\/(\d+)/.exec(created)?.[1]);
                }
                // Auto-merge: into the merge queue once the pull request's CI passes (again after a failure removed it).
                await gh(["pr", "merge", String(pr), "--repo", o.repo, "--auto"]).catch((error) => o.log(`${id}: enabling auto-merge: ${error instanceof Error ? error.message : String(error)}`));
                o.log(`${id}: submitted ${head.slice(0, 8)} as #${pr} (attempt ${attempt + 1})`);
                // The agent is free while its pull request waits for CI and the queue, as the recorded run's agents were
                // (they submitted and stopped); it takes a slot again only to fix a failure.
                // Its checkout is not needed while it waits (a fix starts again from main): free the disk too.
                await serial(() => git(shared, ["worktree", "remove", "--force", wt]));
                release();
                held = false;
                const outcome = await waitFor(pr, head, since);
                if (outcome.kind !== "merged") {
                    await acquire();
                    held = true;
                    await serial(async () => {
                        await must(shared, ["fetch", "--quiet", "lab", "main"], auth);
                        await must(shared, ["worktree", "add", "--quiet", "-B", branch, wt, "lab/main"]);
                    });
                }
                entry.outcomes.push(outcome.kind === "failed" ? outcome.why : outcome.kind);
                // A run outlives sessions; what is known so far is on disk after every outcome.
                writeFileSync(join(o.out, "progress.json"), JSON.stringify({ startedAt, tasks: logs }, null, 2) + "\n");
                o.log(`${id}: #${pr} ${outcome.kind === "failed" ? outcome.why : outcome.kind}`);
                if (outcome.kind === "merged") {
                    entry.landedAt = outcome.at;
                    entry.landedCommit = outcome.commit;
                    entry.result = "landed";
                    break;
                }
                entry.result = outcome.kind === "failed" ? outcome.why : outcome.kind;
                if (outcome.kind === "timeout")
                    break;
            }
            if (!entry.landedAt && task.giveUpMs)
                await sleep(task.giveUpMs * o.scale);
            await serial(() => git(shared, ["worktree", "remove", "--force", wt]));
        }
        finally {
            if (held)
                release();
        }
    };
    // One task's failure (a git or API error) is that task's result, not the end of the experiment.
    await Promise.all(ids.map((_, i) => replayTask(i).catch((error) => {
        logs[i].result = `error: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
        o.log(`${ids[i]}: ${logs[i].result}`);
    })));
    return { tasks: logs, startedAt, endedAt: Date.now() };
}
/** Sum of the job durations of the workflow runs created since `since` (what the runs cost in runner minutes). */
export async function actionsMinutes(repo, since) {
    const created = new Date(since).toISOString().slice(0, 19) + "Z";
    const runs = JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/actions/runs?per_page=100&created=>=${created}`]));
    let jobs = 0;
    let ms = 0;
    const ids = runs.flatMap((p) => p.workflow_runs.map((r) => r.id));
    for (const id of ids) {
        const pages = JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${id}/jobs?per_page=100`]));
        for (const j of pages.flatMap((p) => p.jobs)) {
            if (!j.started_at || !j.completed_at)
                continue;
            jobs++;
            ms += Date.parse(j.completed_at) - Date.parse(j.started_at);
        }
    }
    return { runs: ids.length, jobs, minutes: ms / 60_000 };
}
export async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { repo: { type: "string" }, trace: { type: "string" }, set: { type: "string" }, agents: { type: "string" }, scale: { type: "string", default: "1" }, "arrival-ms": { type: "string", default: "0" }, out: { type: "string" }, tasks: { type: "string" } },
    });
    if (!values.repo || !values.trace || !values.set || !values.agents || !values.out) {
        throw new Error("usage: --repo <org>/<name> --trace <dir> --set bench/issues/<repo>.json --agents N [--scale F] [--arrival-ms N] [--tasks a,b] --out <dir>");
    }
    const traceDir = resolve(values.trace);
    const trace = JSON.parse(readFileSync(join(traceDir, "trace.json"), "utf8"));
    const set = JSON.parse(readFileSync(resolve(values.set), "utf8"));
    const baseDir = benchRoot("issues", `${set.repo.split("/")[1]}-base-${set.baseCommit.slice(0, 12)}`);
    const out = resolve(values.out);
    mkdirSync(out, { recursive: true });
    const log = (line) => console.error(`[lab ${new Date().toISOString().slice(11, 19)}] ${line}`);
    const r = await replayOnGitHub({ repo: values.repo, trace, traceDir, baseDir, agents: Number(values.agents), scale: Number(values.scale), arrivalMs: Number(values["arrival-ms"]), out, log, ...(values.tasks ? { only: values.tasks.split(",") } : {}) });
    const actions = await actionsMinutes(values.repo, r.startedAt);
    const landed = r.tasks.filter((t) => t.landedAt);
    const latencies = landed.map((t) => (t.landedAt - t.submits.at(-1).at) / 60_000).sort((a, b) => a - b);
    const span = landed.length ? (Math.max(...landed.map((t) => t.landedAt)) - Math.min(...r.tasks.flatMap((t) => (t.startedAt ? [t.startedAt] : [])))) / 60_000 : 0;
    const summary = {
        repo: values.repo,
        trace: traceDir,
        agents: Number(values.agents),
        scale: Number(values.scale),
        landed: landed.length,
        tasks: r.tasks.length,
        spanMin: span,
        landLatencyMin: { median: latencies[Math.floor(latencies.length / 2)] ?? 0, p90: latencies[Math.floor(latencies.length * 0.9)] ?? 0, max: latencies.at(-1) ?? 0 },
        failures: r.tasks.reduce((n, t) => n + t.outcomes.filter((x) => x !== "merged").length, 0),
        actions,
    };
    writeFileSync(join(out, "report.json"), JSON.stringify({ summary, tasks: r.tasks }, null, 2) + "\n");
    console.log(JSON.stringify(summary, null, 2));
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=replay.js.map