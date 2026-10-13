// The vanilla baseline arm: same host, worktrees, task text and budgets, but no coordinator or executor.
// Agents coordinate through a shared notes directory and push to the host's main themselves; a task counts
// as landed when its worktree's final HEAD (past the base) is an ancestor of main.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, hasCommit, isAncestor } from "../executor/git.js";
import { LocalBareHost } from "../executor/host.js";
import { runAgent, UsageLimitError, usageLimitOf } from "./agents.js";
import { baselinePrompt } from "./prompts.js";
import { systemCost } from "./report.js";
import { DEFAULT_AGENT_TIMEOUT_MS, defaultLog, lazyWorktrees, relatedCommandFor, runFinalSuite, sharedLaunchDir, taskArrivals, warmupGate, withTaskIds, writeReports } from "./run.js";
import { createWorktree, forkFromMain } from "./worktrees.js";
export async function runBaseline(cfg) {
    const out = resolve(cfg.out);
    mkdirSync(out, { recursive: true });
    const log = cfg.log ?? defaultLog;
    const startedAt = Date.now();
    const repo = resolve(cfg.repo);
    const baseCommit = await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const tasks = withTaskIds(cfg.tasks);
    const arrivals = taskArrivals(tasks, startedAt, cfg.arrivalMs);
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const gate = cfg.gateOnDependencies !== false;
    const pollMs = cfg.dependencyPollMs ?? 2000;
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0)
        throw new Error("dependencyPollMs must be a positive integer");
    const host = await LocalBareHost.init(join(out, "host.git"), repo, baseCommit);
    const notesDir = join(out, "notes");
    mkdirSync(notesDir, { recursive: true });
    writeFileSync(join(notesDir, "README.md"), `Shared notes: one file per agent, named <taskId>.md. Agents: ${tasks.map((t) => t.id).join(", ")}.\n`);
    // Worktrees on demand with prefetch, copy-on-write from the prepared base when there is one: the same setup as the
    // commons arm, so neither arm's wall clock carries clone time the other does not.
    const worktrees = new Map();
    const forkBases = new Map();
    const ensureWorktree = lazyWorktrees(tasks, cfg.prefetch ?? 4, async (t) => {
        const dir = await createWorktree(host.url, join(out, "worktrees", t.id), baseCommit, t.id, {
            ...(cfg.nodeModules ? { nodeModules: cfg.nodeModules } : {}),
            ...(cfg.cowFrom ? { cowFrom: cfg.cowFrom } : {}),
            meta: { hostUrl: host.url, arm: "baseline", notesDir },
        });
        if (cfg.prepareCheckout)
            await cfg.prepareCheckout(dir);
        worktrees.set(t.id, dir);
        return dir;
    });
    const logDir = join(out, "logs");
    const launchDir = cfg.sharedCwd ? sharedLaunchDir(out) : null;
    if (launchDir)
        log(`agents launch from the shared directory ${launchDir}`);
    const warmup = warmupGate(cfg.warmupMs);
    const relatedCommand = relatedCommandFor(cfg.checks);
    const startAgent = async (t) => {
        const worktree = worktrees.get(t.id) ?? (await ensureWorktree(t));
        if (cfg.forkFrom === "main") {
            await warmup();
            forkBases.set(t.id, await forkFromMain(worktree));
        }
        else if (gate && t.dependsOn?.length) {
            // Consumers begin with the landed producer code, even though all clones were created at the base.
            await git(worktree, ["fetch", "--quiet", "origin", "main"]);
            await git(worktree, ["rebase", "origin/main"]);
        }
        // A no-op agent on a newer fork must not be credited for a peer's landing; base mode keeps its old accounting.
        if (cfg.forkFrom !== "main")
            forkBases.set(t.id, baseCommit);
        const peerTaskIds = tasks.filter((p) => p.id !== t.id).map((p) => p.id);
        const prompt = baselinePrompt({ taskId: t.id, title: t.title, body: t.body, relatedCommand, testCommand: cfg.checks.test, notesDir, peerTaskIds, maxResubmits: cfg.maxResubmits, dependsOn: t.dependsOn, dependenciesLanded: gate, ...(launchDir ? { worktree } : {}) });
        const env = {
            COMMONS_ARM: "baseline",
            COMMONS_TASK: t.id,
            COMMONS_HOST: host.url,
            COMMONS_WORKTREE: worktree,
            COMMONS_NOTES_DIR: notesDir,
        };
        if (cfg.agent === "fake")
            env.COMMONS_TASK_BODY = t.body;
        if (cfg.forkFrom !== "main")
            await warmup();
        log(`agent ${t.id} starting (${cfg.agent}, baseline)`);
        const run = await runAgent({
            kind: cfg.agent,
            taskId: t.id,
            cwd: launchDir ?? worktree,
            prompt,
            ...(cfg.model ? { model: cfg.model } : {}),
            ...(cfg.maxTurns !== undefined ? { maxTurns: cfg.maxTurns } : {}),
            ...(cfg.maxBudgetUsd !== undefined ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
            timeoutMs,
            env,
            logDir,
        });
        log(`agent ${t.id} finished: exit ${run.exitCode}${run.timedOut ? " (timeout)" : ""} after ${(run.durationMs / 1000).toFixed(1)} s`);
        const limit = usageLimitOf(run);
        if (limit) {
            if (!exhausted)
                log(`agent ${t.id} hit the account's usage limit (${limit}); no further agents start`);
            exhausted ??= limit;
        }
        return run;
    };
    let exhausted = null;
    // Check in the host so polling never races the agent's fetch/rebase locks. Its HEAD may not have
    // been pushed yet; only a commit reachable from the host's actual main releases a dependency.
    const landingOf = async (taskId, main = "refs/heads/main") => {
        const worktree = worktrees.get(taskId);
        const fork = forkBases.get(taskId);
        if (!worktree || !fork)
            return { head: baseCommit, landed: false }; // only prefetched, or not started yet
        const head = await git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
        const landed = head !== fork && (await hasCommit(host.url, head)) && (await isAncestor(host.url, head, main));
        return { head, landed };
    };
    const pending = new Map(tasks.map((t) => [t.id, t]));
    const runs = new Map();
    const running = new Map();
    const landed = new Set();
    const blockedBy = new Map();
    const taskIds = new Set(pending.keys());
    const concurrency = Math.max(1, cfg.agents);
    while (pending.size || running.size) {
        if (exhausted && pending.size)
            pending.clear(); // the account is out of usage: launching more agents measures nothing
        const finished = new Set(runs.keys());
        if (gate) {
            for (const id of [...running.keys(), ...runs.keys()]) {
                if (!landed.has(id) && (await landingOf(id)).landed) {
                    landed.add(id);
                    log(`task ${id} landed on host main`);
                }
            }
        }
        // Waiting tasks occupy no agent slots: consumers can precede producers in the input, even at N=1.
        const now = Date.now();
        for (const [id, t] of pending) {
            const unresolved = gate ? (t.dependsOn ?? []).filter((dep) => !landed.has(dep)) : [];
            const failed = unresolved.filter((dep) => !taskIds.has(dep) || finished.has(dep) || blockedBy.has(dep));
            if (failed.length) {
                blockedBy.set(id, failed);
                pending.delete(id);
                log(`agent ${id} not started: blocked by ${failed.join(", ")}`);
            }
            else if (!unresolved.length && arrivals.get(id) <= now && running.size < concurrency) {
                pending.delete(id);
                running.set(id, startAgent(t).then((run) => {
                    runs.set(id, run);
                    running.delete(id);
                }));
            }
        }
        const nextArrival = Math.min(...[...pending.keys()].map((id) => arrivals.get(id)).filter((at) => at > now));
        if (!running.size) {
            // An agent may have finished during the Git probes; recheck its final HEAD before blocking consumers.
            if (runs.size > finished.size)
                continue;
            if (Number.isFinite(nextArrival)) {
                await new Promise((r) => setTimeout(r, Math.max(1, Math.min(30_000, nextArrival - Date.now()))));
                continue;
            }
            // No runnable producers remain (e.g. a dependency cycle). Report the unreleased dependencies.
            for (const [id, t] of pending) {
                const blockers = (t.dependsOn ?? []).filter((dep) => !landed.has(dep));
                blockedBy.set(id, blockers);
                log(`agent ${id} not started: blocked by ${blockers.join(", ")}`);
            }
            pending.clear();
        }
        else if ((gate && pending.size) || Number.isFinite(nextArrival)) {
            let timer;
            try {
                await Promise.race([...running.values(), new Promise((r) => { timer = setTimeout(r, Math.max(1, Math.min(pollMs, nextArrival - Date.now()))); })]);
            }
            finally {
                clearTimeout(timer);
            }
        }
        else {
            await Promise.race(running.values());
        }
    }
    if (exhausted)
        throw new UsageLimitError(exhausted, "baseline");
    const agents = tasks.flatMap((t) => runs.has(t.id) ? [runs.get(t.id)] : []);
    const finalMain = await git(host.url, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
    const taskReports = [];
    for (const t of tasks) {
        let head = baseCommit;
        let landed = false;
        try {
            ({ head, landed } = await landingOf(t.id, finalMain));
        }
        catch (error) {
            log(`task ${t.id}: could not determine landing: ${error instanceof Error ? error.message : String(error)}`);
        }
        const tr = { id: t.id, title: t.title, landed, bounces: 0, conflicts: 0, branchHead: head };
        if (blockedBy.has(t.id)) {
            tr.landed = false;
            tr.status = "blocked";
            tr.blockedBy = blockedBy.get(t.id);
        }
        taskReports.push(tr);
    }
    // Landings are read from the worktrees, so they are computed before official scoring, which may prune them.
    const official = cfg.official ? await cfg.official(finalMain) : undefined;
    for (const tr of taskReports)
        if (official && tr.id in official)
            tr.official = official[tr.id];
    const suite = await runFinalSuite(out, host.url, finalMain, cfg.checks.test, {
        ...(cfg.nodeModules ? { nodeModules: cfg.nodeModules } : {}),
        ...(cfg.prepareCheckout ? { prepareCheckout: cfg.prepareCheckout } : {}),
        ...(cfg.executor?.checkTimeoutMs ? { timeoutMs: cfg.executor.checkTimeoutMs } : {}),
    });
    const endedAt = Date.now();
    const report = {
        arm: "baseline",
        agent: cfg.agent,
        ...(cfg.model ? { model: cfg.model } : {}),
        concurrency: cfg.agents,
        checks: cfg.checks,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        wallMs: endedAt - startedAt,
        out,
        baseCommit,
        finalMain,
        finalSuitePassed: suite.passed,
        tasks: taskReports,
        agents,
        executorCostUsd: 0,
        systemCostUsd: systemCost({ agents, executorCostUsd: 0 }),
        metrics: null,
        events: [],
        ...(official ? { official } : {}),
    };
    writeReports(out, report);
    log(`done: ${taskReports.filter((t) => t.landed).length}/${taskReports.length} landed, final suite ${suite.passed === null ? "n/a" : suite.passed ? "pass" : "fail"}`);
    return report;
}
//# sourceMappingURL=baseline.js.map