// The swarm runner (SPEC §10): one coordinator, one host, one executor, one worktree per task, N concurrent
// agents, then a report. Everything lives under `cfg.out`; the source repository is only read.
import { createHash } from "node:crypto";
import { loadavg, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CoordinatorClient } from "../adapter/client.js";
import { linkNodeModules } from "../bench/rhf/prepare.js";
import { openNodeSql } from "../core/sql-node.js";
import { CheckCache, CommandCheck, runCommand } from "../executor/checks.js";
import { closureIndex } from "../executor/footprint.js";
import { blobsOf, closureKey } from "../executor/verdict-key.js";
import { runExecutor } from "../executor/executor.js";
import { git, gitRaw } from "../executor/git.js";
import { LocalBareHost, ensureWorkClone } from "../executor/host.js";
import { inferScopes } from "../index/scope.js";
import { indexRepo } from "../index/symbols.js";
import { synthesizeContracts } from "../planning/contracts.js";
import { serve } from "../service/node-server.js";
import { claudeHookSettings, emptyPhases, mcpCommandFor, mcpConfigFor, PHASES, runAgent, UsageLimitError, usageLimitOf } from "./agents.js";
import { renderBrief } from "../brief/brief.js";
import { taskHints } from "../verify/hints.js";
import { selectCandidate } from "./best-of.js";
import { renderVerdict } from "../adapter/mcp.js";
import { commonsPrompt, queuePrompt, resumePrompt } from "./prompts.js";
import { renderReport, systemCost } from "./report.js";
import { createWorktree, forkFromMain, setOrigin } from "./worktrees.js";
import { cowCopy } from "../executor/cow.js";
import { reapScope, reapStrays } from "./reap.js";
import { checkSlotsEnv } from "../executor/slots.js";
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
/** Detached agents: resumes after a bounce when `maxResubmits` is not set. */
export const DEFAULT_DETACH_RESUBMITS = 3;
export const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;
const DRAIN_POLL_MS = 500;
const EVENT_PAGE = 500;
export const defaultLog = (line) => {
    console.error(`[runner] ${line}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Returns a function that lets the first caller through at once and holds every later caller until `warmupMs` after it. */
export function warmupGate(warmupMs) {
    if (!warmupMs || warmupMs <= 0)
        return async () => undefined;
    let firstAt = null;
    return async () => {
        if (firstAt === null) {
            firstAt = Date.now();
            return;
        }
        const wait = firstAt + warmupMs - Date.now();
        if (wait > 0)
            await new Promise((resolve) => setTimeout(resolve, wait));
    };
}
/** Arrival deadlines are tied to input order and the arm's clock, independent of clone/admission delays. */
export function taskArrivals(tasks, startedAt, arrivalMs = 0) {
    if (!Number.isSafeInteger(arrivalMs) || arrivalMs < 0 || !Number.isSafeInteger(startedAt + Math.max(0, tasks.length - 1) * arrivalMs))
        throw new Error("arrivalMs must be a non-negative integer with safe arrival deadlines");
    return new Map(tasks.map((t, i) => [t.id, startedAt + i * arrivalMs]));
}
/** A neutral launch directory for a run, outside any repository, keyed by the run's output directory. */
export function sharedLaunchDir(out) {
    const dir = join(tmpdir(), "commons-swarm", createHash("sha1").update(resolve(out)).digest("hex").slice(0, 12));
    mkdirSync(dir, { recursive: true });
    return dir;
}
/** Assign `task<N>` ids where missing and reject duplicates. */
export function withTaskIds(tasks) {
    const seen = new Set();
    return tasks.map((t, i) => {
        const id = t.id ?? `task${i + 1}`;
        if (seen.has(id))
            throw new Error(`duplicate task id ${id}`);
        seen.add(id);
        return { ...t, id };
    });
}
/** Fill missing writes/reads from the symbol index (BM25 over paths and exports). */
export function withScopes(repo, commit, tasks) {
    if (tasks.every((t) => t.writes?.length && t.reads?.length))
        return tasks;
    const index = indexRepo(repo, { commit });
    return tasks.map((t) => {
        if (t.writes?.length && t.reads?.length)
            return t;
        const inferred = inferScopes(index, t);
        return { ...t, writes: t.writes?.length ? t.writes : inferred.writes, reads: t.reads?.length ? t.reads : inferred.reads };
    });
}
/** The related-test command shown to agents: the template with a placeholder, or the full command. */
export function relatedCommandFor(checks) {
    return checks.related ? checks.related.split("{files}").join("<changed files>") : checks.test;
}
/** Run `fn` over `items` with at most `n` in flight; results keep the input order. */
/**
 * Create one resource per task on demand, at most `n` at a time, prefetching in task order: `get(t)` returns the
 * task's (starting it now if the prefetch has not reached it yet).
 */
export function lazyWorktrees(tasks, n, create) {
    const started = new Map();
    let active = 0;
    const waiting = [];
    const slot = async (fn) => {
        if (active >= n)
            await new Promise((resolve) => waiting.push(resolve));
        active++;
        try {
            return await fn();
        }
        finally {
            active--;
            waiting.shift()?.();
        }
    };
    const get = (t) => {
        let p = started.get(t.id);
        if (!p) {
            p = slot(() => create(t));
            started.set(t.id, p);
        }
        return p;
    };
    for (const t of tasks)
        get(t).catch(() => undefined);
    return get;
}
export async function pool(items, n, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
/**
 * Like `pool`, for jobs that can spawn follow-ups after they release their slot: `fn` may call `later(p)` with a
 * promise of a follow-up job (or undefined), which is queued when it resolves. Finishes when nothing is queued,
 * running or pending.
 */
export async function schedule(initial, n, fn, onError) {
    const queue = [...initial];
    let active = 0;
    let pending = 0;
    await new Promise((resolve, reject) => {
        let failed = false;
        const fail = (error) => {
            failed = true;
            reject(error);
        };
        const settle = () => {
            if (!failed && queue.length === 0 && active === 0 && pending === 0)
                resolve();
        };
        const pump = () => {
            while (!failed && active < Math.max(1, n) && queue.length > 0) {
                const job = queue.shift();
                active++;
                fn(job, later).then(() => {
                    active--;
                    pump();
                }, (error) => {
                    active--;
                    // With onError a failed job is reported and the others go on; without it the first failure ends them all.
                    if (onError) {
                        onError(error, job);
                        pump();
                    }
                    else
                        fail(error);
                });
            }
            settle();
        };
        const later = (followUp) => {
            pending++;
            followUp.then((next) => {
                pending--;
                if (next !== undefined)
                    queue.push(next);
                pump();
            }, (error) => {
                pending--;
                if (onError) {
                    onError(error, undefined);
                    pump();
                    return;
                }
                fail(error);
            });
        };
        pump();
    });
}
/** One run per task from its segments (a detached agent's initial run and each resume): sums the usage, keeps the last outcome. */
export function mergeRuns(segments, verdictWaitMs) {
    const first = segments[0];
    if (segments.length === 1 && verdictWaitMs === 0)
        return first;
    const last = segments[segments.length - 1];
    const phases = emptyPhases();
    const tokens = { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 };
    let durationMs = 0;
    let submitWaitMs = 0;
    let costUsd;
    let turns;
    for (const s of segments) {
        durationMs += s.durationMs;
        submitWaitMs += s.submitWaitMs;
        for (const k of ["input", "cachedInput", "cacheCreation", "output"])
            tokens[k] += s.tokens[k];
        for (const phase of PHASES)
            for (const k of ["calls", "ms", "input", "cachedInput", "cacheCreation", "output"])
                phases[phase][k] += s.phases[phase][k];
        if (s.costUsd !== undefined)
            costUsd = (costUsd ?? 0) + s.costUsd;
        if (s.turns !== undefined)
            turns = (turns ?? 0) + s.turns;
    }
    return {
        ...last,
        command: first.command,
        startedAt: first.startedAt,
        durationMs,
        submitWaitMs,
        tokens,
        phases,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(turns !== undefined ? { turns } : {}),
        resumes: segments.length - 1,
        verdictWaitMs,
    };
}
const TERMINAL = new Set(["landed", "bounced", "superseded"]);
/**
 * Detached mode: wait, with no agent running, for the task's newest submission to reach a verdict. Returns null
 * when the task has no open submission, or when the queue stalls (no verdict anywhere for `stallMs`).
 */
export async function waitForVerdict(client, repoId, taskId, stallMs, pollMs = 2000) {
    const clock = stallClock(client, repoId, stallMs);
    for (;;) {
        const status = await client.taskStatus(repoId, taskId);
        if (status.task.status === "landed" || status.task.status === "abandoned") {
            const landed = status.submissions.find((s) => s.status === "landed") ?? null;
            // An optimistic landing is final once its combined check settles it: verified, or reverted (the task bounces).
            if (!landed?.verdict?.optimistic || landed.verdict.verified || status.task.status === "abandoned")
                return landed;
            if ((await clock()).expired)
                return landed;
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            continue;
        }
        const newest = [...status.submissions].sort((a, b) => b.createdAt - a.createdAt).find((s) => s.status !== "superseded");
        if (!newest)
            return null;
        if (TERMINAL.has(newest.status))
            return newest;
        if ((await clock()).expired)
            return null;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}
/** Clone the host into `<out>/final` at `commit` and run the full test command there. */
export async function runFinalSuite(out, hostUrl, commit, testCommand, opts = {}) {
    const dir = join(out, "final");
    const started = Date.now();
    try {
        if (opts.cowFrom) {
            await cowCopy(resolve(opts.cowFrom), dir);
            await setOrigin(dir, hostUrl);
            await git(dir, ["fetch", "--quiet", "origin"]);
        }
        else
            await git(out, ["clone", "--quiet", hostUrl, dir]);
        await git(dir, ["checkout", "--quiet", "--detach", commit]);
        if (opts.nodeModules)
            await linkNodeModules(opts.nodeModules, dir);
        if (opts.prepareCheckout)
            await opts.prepareCheckout(dir);
        const r = await runCommand(["sh", "-c", testCommand], { cwd: dir, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
        writeFileSync(join(out, "final-suite.log"), r.output);
        const excerpt = r.output.trim().split(/\r?\n/).slice(-20).join("\n");
        return { passed: !r.timedOut && r.code === 0, dir, code: r.code, excerpt, durationMs: Date.now() - started };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeFileSync(join(out, "final-suite.log"), `final suite could not run: ${message}\n`);
        return { passed: null, dir, code: null, excerpt: message, durationMs: Date.now() - started };
    }
}
export function writeReports(out, report) {
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(out, "report.md"), renderReport([report]));
}
async function allEvents(client, repoId) {
    const out = [];
    let after = 0;
    for (;;) {
        const page = await client.events(repoId, after, EVENT_PAGE);
        if (page.length === 0)
            break;
        out.push(...page);
        after = page[page.length - 1].seq;
        if (page.length < EVENT_PAGE)
            break;
    }
    return out;
}
/** Per-task bounce and conflict counts from the event log. */
export function bounceCounts(events) {
    const out = new Map();
    for (const e of events) {
        if (e.type !== "bounce" || !e.taskId)
            continue;
        const entry = out.get(e.taskId) ?? { bounces: 0, conflicts: 0 };
        entry.bounces++;
        const payload = e.payload;
        if (payload?.verdict?.conflicts && payload.verdict.conflicts.length > 0)
            entry.conflicts++;
        out.set(e.taskId, entry);
    }
    return out;
}
/**
 * A deadline that moves while the queue makes progress: it expires once no submission anywhere reached a verdict
 * for `stallMs`. A fixed deadline cut the fifth twenty-five-issue run's commons arm short with six submissions still
 * queued behind heavy checks that were landing one after another.
 */
export function stallClock(client, repoId, stallMs, now = Date.now) {
    let settled = -1;
    let since = now();
    return async () => {
        const m = await client.metrics(repoId);
        // Progress: a verdict anywhere, or an optimistic landing settled.
        const count = (m.submissions.landed + m.submissions.bounced + m.submissions.superseded) * 1_000_003 + (m.reverted ?? 0) * 1_009 - (m.unverified ?? 0);
        if (count !== settled) {
            settled = count;
            since = now();
        }
        return { expired: now() - since >= stallMs, queued: m.submissions.queued, leased: m.submissions.leased, unverified: m.unverified ?? 0 };
    };
}
async function waitForDrain(client, repoId, stallMs, log) {
    const clock = stallClock(client, repoId, stallMs);
    for (;;) {
        const s = await clock();
        if (s.queued + s.leased + s.unverified === 0)
            return;
        if (s.expired) {
            log(`drain stalled: no verdict for ${Math.round(stallMs / 60000)} min; ${s.queued} queued, ${s.leased} leased, ${s.unverified} unverified optimistic landing(s) left`);
            return;
        }
        await sleep(DRAIN_POLL_MS);
    }
}
export async function runSwarm(cfg) {
    const log = cfg.log ?? defaultLog;
    const saved = { TMPDIR: process.env.TMPDIR, COMMONS_CHECK_SLOTS: process.env.COMMONS_CHECK_SLOTS };
    // Arm-scoped environment: everything the arm spawns (agents, their MCP servers and pre-verifications, the
    // in-process integrators' checks) inherits it from this process.
    const armTmp = cfg.isolateTmp ? mkdtempSync("/tmp/cb-") : null;
    if (armTmp)
        process.env.TMPDIR = armTmp;
    if (cfg.checkSlots && cfg.checkSlots > 0) {
        const dir = join(resolve(cfg.out), "check-slots");
        rmSync(dir, { recursive: true, force: true });
        process.env.COMMONS_CHECK_SLOTS = checkSlotsEnv({ count: cfg.checkSlots, dir });
        log(`at most ${cfg.checkSlots} heavy check(s) at once on this machine`);
    }
    // The machine as the arm saw it, once a minute: other work on it (other sessions' builds and tests) skewed whole
    // runs, and a run's log is where that has to be visible afterwards.
    const machine = setInterval(() => {
        let free = "";
        try {
            const fs = statfsSync(resolve(cfg.out));
            free = `, ${((fs.bavail * fs.bsize) / 1e9).toFixed(1)} GB free`;
        }
        catch {
            // no statfs
        }
        log(`machine: load ${loadavg().map((n) => n.toFixed(1)).join(" ")}${free}`);
    }, 60_000);
    machine.unref();
    // Nothing an arm started may outlive it, even when the runner is stopped: leftover processes skew every later
    // measurement on this machine.
    const scope = reapScope({
        log,
        teardown: () => {
            reapStrays(resolve(cfg.out), log);
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
            if (armTmp) {
                reapStrays(armTmp, log);
                rmSync(armTmp, { recursive: true, force: true });
            }
        },
    });
    try {
        return await runArm(cfg);
    }
    finally {
        clearInterval(machine);
        scope.close();
    }
}
async function runArm(cfg) {
    if (cfg.arm === "baseline") {
        if (cfg.contracts)
            (cfg.log ?? defaultLog)("contracts: planner feature, not applied to the baseline arm");
        const { runBaseline } = await import("./baseline.js");
        return runBaseline(cfg);
    }
    const mode = cfg.mode ?? (cfg.arm === "queue" || cfg.arm === "github" ? "queue" : "full");
    const arm = cfg.arm === "github" ? "github" : mode === "queue" ? "queue" : "commons";
    const admission = mode === "queue" ? "none" : cfg.admission ?? "none";
    const out = resolve(cfg.out);
    // Checkouts under a node_modules ancestor resolve packages from it (see bench/issues/prepare.ts benchRoot).
    for (let d = dirname(out); d !== dirname(d); d = dirname(d)) {
        if (existsSync(join(d, "node_modules"))) {
            (cfg.log ?? console.error)(`[runner] warning: ${out} lies under ${join(d, "node_modules")}; tests in the checkouts may resolve packages from it. Use an out directory outside any node_modules ancestor.`);
            break;
        }
    }
    mkdirSync(out, { recursive: true });
    const log = cfg.log ?? defaultLog;
    const startedAt = Date.now();
    const repo = resolve(cfg.repo);
    const baseCommit = await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    let tasks = withScopes(repo, baseCommit, withTaskIds(cfg.tasks));
    if (cfg.contracts) {
        const synthesized = synthesizeContracts(tasks, typeof cfg.contracts === "object" ? cfg.contracts : undefined);
        tasks = synthesized.tasks;
        for (const c of synthesized.contracts)
            log(`contract ${c.id}: ${c.path}#${c.symbol} for ${c.writers.join(", ")}`);
    }
    const arrivals = taskArrivals(tasks, startedAt, cfg.arrivalMs);
    const index = indexRepo(repo, { commit: baseCommit }); // for the briefs recorded in landing notes
    const repoId = cfg.repoId ?? "bench";
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    // Either an in-process coordinator (default) or a remote control plane (hosted mode: metadata only leaves the machine).
    const server = cfg.coordinatorUrl
        ? { url: cfg.coordinatorUrl.replace(/\/+$/, ""), close: async () => undefined }
        : await serve({ port: 0, dbPath: join(out, "coordinator.sqlite") });
    log(`coordinator listening at ${server.url}`);
    log(`dashboard: ${server.url}/?repo=${encodeURIComponent(repoId)}&url=${encodeURIComponent(server.url)}${cfg.coordinatorToken ? "&token=<token>" : ""}`);
    const cacheSql = openNodeSql(join(out, "cache.sqlite"));
    const abort = new AbortController();
    let executor;
    try {
        const host = await LocalBareHost.init(join(out, "host.git"), repo, baseCommit);
        const client = new CoordinatorClient(server.url, cfg.coordinatorToken);
        await client.createRepo({
            id: repoId,
            name: basename(repo),
            mainCommit: baseCommit,
            testCommand: cfg.checks.test,
            ...(cfg.checks.related ? { relatedTestCommand: cfg.checks.related } : {}),
            admission,
            ...(cfg.window === "auto" ? { window: 1, windowPolicy: "adaptive", windowMax: 4 } : typeof cfg.window === "number" ? { window: cfg.window } : {}),
            privacy: "plain",
        });
        await client.addTasks(repoId, tasks);
        await client.plan(repoId);
        const worktrees = new Map();
        // Executor: in-process, with its own clone of the host (dependencies linked before the first lease).
        const work = join(out, "work");
        await ensureWorkClone(work, host, cfg.cowFrom);
        if (cfg.nodeModules)
            await linkNodeModules(cfg.nodeModules, work);
        if (cfg.prepareCheckout)
            await cfg.prepareCheckout(work);
        const checkTimeout = cfg.executor?.checkTimeoutMs ? { timeoutMs: cfg.executor.checkTimeoutMs } : {};
        // relatedCheck=false: the full suite is cheap enough to be the only check (the prompt still names the
        // related command for the agent's local iteration).
        const useRelated = Boolean(cfg.checks.related) && cfg.executor?.relatedCheck !== false;
        const checks = [
            new CommandCheck("related", cfg.checks.test, { ...(useRelated ? { relatedTemplate: cfg.checks.related } : {}), ...checkTimeout }),
        ];
        // Without a related template the "related" check already is the full suite; do not run it twice.
        const landChecks = useRelated && cfg.executor?.fullSuitePerBatch !== false ? [new CommandCheck("full", cfg.checks.test, checkTimeout)] : [];
        const integrators = Math.max(1, cfg.executor?.integrators ?? 1);
        const executorOptions = (workDir, executorId) => ({
            work: workDir,
            host,
            checks,
            landChecks,
            cache: new CheckCache(cacheSql, { client, repoId }),
            client,
            repoId,
            executorId,
            batchSize: cfg.executor?.batchSize ?? 4,
            ...(cfg.llmResolve ? { llmResolve: cfg.llmResolve } : {}),
            ...(cfg.replay === false ? { replay: false } : {}),
            ...(cfg.structuredMerge === false ? { structuredMerge: false } : {}),
            ...(cfg.closureKeys === false ? { closureKeys: false } : {}),
            ...(integrators > 1 ? { affinity: true } : {}),
            ...(integrators > 1 && cfg.executor?.speculate ? { speculate: true } : {}),
            ...(cfg.executor?.optimistic ? { optimistic: cfg.executor.optimistic } : {}),
            // Landing notes: the runner knows each task's title, which agent kind/model worked on it, and the brief it got.
            annotate: async (taskId) => {
                const task = tasks.find((t) => t.id === taskId);
                let brief;
                try {
                    const meta = await client.briefMeta(repoId, taskId);
                    const wt = worktrees.get(taskId);
                    brief = renderBrief(meta, cfg.forkFrom === "main" && wt ? indexRepo(wt, { commit: meta.task.baseCommit }) : index);
                }
                catch {
                    brief = undefined;
                }
                return { ...(task ? { title: task.title } : {}), agent: { kind: cfg.agent, ...(cfg.model ? { model: cfg.model } : {}) }, ...(brief ? { brief } : {}) };
            },
        });
        const executorRuns = [];
        // One background clone at a time, beside the agents' worktree prefetch, so the first agents are not slowed.
        let cloning = Promise.resolve();
        const prepareClone = (dir) => {
            const next = cloning.then(async () => {
                await ensureWorkClone(dir, host, cfg.cowFrom);
                if (cfg.nodeModules)
                    await linkNodeModules(cfg.nodeModules, dir);
                if (cfg.prepareCheckout)
                    await cfg.prepareCheckout(dir);
            });
            cloning = next.catch(() => undefined);
            return next;
        };
        for (let i = 1; i <= integrators; i++) {
            const workDir = i === 1 ? work : `${work}-${i}`;
            // Integrators beyond the first, and the verification clones of optimistic landing, are cloned in the
            // background: no submission needs them before the first agent has worked for a while.
            const verifyDir = cfg.executor?.optimistic ? `${workDir}-verify` : undefined;
            executorRuns.push((async () => {
                if (i > 1)
                    await prepareClone(workDir);
                // Verification clones (two per integrator, so post-landing checks run side by side) may still be cloning when
                // the first optimistic landing wants one; that check waits.
                const verifyWork = verifyDir ? [verifyDir, `${verifyDir}-2`].map((dir) => prepareClone(dir).then(() => dir)) : undefined;
                // Each integrator gets its own host handle: "last known main" is per work clone, not per process.
                const opts = executorOptions(workDir, integrators > 1 ? `runner-${i}` : "runner");
                return runExecutor({ ...opts, host: i === 1 ? host : new LocalBareHost(host.url, host.knownMain), ...(verifyWork ? { verifyWork, verifyHost: new LocalBareHost(host.url) } : {}) }, { pollMs: cfg.executor?.pollMs ?? 500, signal: abort.signal });
            })());
        }
        if (integrators > 1)
            log(`${integrators} integrators`);
        executor = Promise.all(executorRuns).then((all) => ({ executorCostUsd: all.reduce((s, x) => s + x.executorCostUsd, 0), resolverCalls: all.reduce((s, x) => s + x.resolverCalls, 0) }));
        // Worktrees on demand, prefetched in task order a few at a time: an agent starts as soon as its own worktree
        // exists instead of after all of them (cloning 25 workers-sdk checkouts up front took 10 to 13 minutes).
        const ensureWorktree = lazyWorktrees(tasks, cfg.prefetch ?? 4, async (t) => {
            const dir = await createWorktree(host.url, join(out, "worktrees", t.id), baseCommit, t.id, {
                ...(cfg.nodeModules ? { nodeModules: cfg.nodeModules } : {}),
                ...(cfg.cowFrom ? { cowFrom: cfg.cowFrom } : {}),
                meta: { repoId, coordinatorUrl: server.url, hostUrl: host.url, arm },
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
        const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // Admission gating: a blocked task's agent does not start until the coordinator admits it (its blockers
        // landed, or in pipeline mode submitted). With admission "none" nothing is ever blocked.
        const waitForAdmission = async (taskId) => {
            const deadline = Date.now() + timeoutMs;
            let waited = false;
            for (;;) {
                const status = (await client.taskStatus(repoId, taskId)).task.status;
                if (status !== "blocked") {
                    if (waited)
                        log(`agent ${taskId} admitted`);
                    return status;
                }
                if (Date.now() > deadline) {
                    log(`agent ${taskId} still blocked after the timeout; starting anyway`);
                    return status;
                }
                if (!waited)
                    log(`agent ${taskId} waiting for admission`);
                waited = true;
                await sleepMs(2000);
            }
        };
        const detach = Boolean(cfg.detach || cfg.lean);
        const hooksOn = mode === "full" && cfg.agent === "claude" && cfg.hooks !== false;
        const promptExtras = async (t, worktree) => {
            const extras = {};
            if (detach)
                extras.detach = true;
            if (cfg.trustQueue)
                extras.trustQueue = true;
            if (!cfg.lean || mode !== "full")
                return extras;
            if (hooksOn)
                extras.deltaViaHook = true;
            try {
                const meta = await client.briefMeta(repoId, t.id); // marks the task working, as the brief tool would
                const exemplarDiffs = {};
                if (meta.exemplars?.length) {
                    await git(worktree, ["fetch", "--quiet", "origin", "main"]).catch(() => undefined);
                    for (const e of meta.exemplars) {
                        const r = await gitRaw(worktree, ["diff", e.fromMain, e.toMain]);
                        if (r.code === 0)
                            exemplarDiffs[e.toMain] = r.stdout;
                    }
                }
                extras.brief = renderBrief(meta, cfg.forkFrom === "main" ? indexRepo(worktree, { commit: meta.task.baseCommit }) : index, { exemplarDiffs });
                if (cfg.hints) {
                    // Coverage-guided context: the files and functions the task's words and the base's tests point at.
                    const hints = taskHints(cfg.forkFrom === "main" ? worktree : repo, { title: t.title, body: t.body ?? "", writes: t.writes ?? [] });
                    if (hints)
                        extras.brief = `${extras.brief.trimEnd()}\n\n${hints}\n`;
                }
            }
            catch (error) {
                log(`agent ${t.id}: brief could not be inlined (${error.message}); the agent calls the tool`);
            }
            return extras;
        };
        const segments = new Map();
        let exhausted = null;
        const verdictWaits = new Map();
        const maxResumes = cfg.maxResubmits ?? DEFAULT_DETACH_RESUBMITS;
        const detachedPollMs = cfg.executor?.pollMs ?? 2000;
        const bestOf = Math.max(1, cfg.bestOf ?? 1);
        const bestOfScores = new Map();
        // A best-of job runs N agents at once: N times fewer jobs side by side keeps the agent concurrency as configured.
        await schedule(tasks.map((task) => ({ task, attempt: 0 })), bestOf > 1 ? Math.max(1, Math.floor(cfg.agents / bestOf)) : cfg.agents, async (job, later) => {
            const t = job.task;
            let worktree = worktrees.get(t.id) ?? (await ensureWorktree(t));
            if (exhausted)
                return; // the account is out of usage: launching more agents measures nothing
            if (job.attempt === 0) {
                // Bound individual timers: Node overflows delays above 2^31 ms and starts those tasks immediately.
                while (arrivals.get(t.id) > Date.now())
                    await sleepMs(Math.min(30_000, arrivals.get(t.id) - Date.now()));
            }
            if (job.attempt === 0 && mode === "full" && cfg.gateOnAdmission !== false)
                await waitForAdmission(t.id);
            if (exhausted)
                return;
            let taskBase = baseCommit;
            const readyToLaunch = async (dirs) => {
                if (job.attempt !== 0)
                    return; // a bounce resumes the agent's own commits and uncommitted work
                if (cfg.forkFrom !== "main")
                    return;
                await warmup();
                // Preparation/prefetch and every gate precede this snapshot. Best-of candidates launch together from
                // one task fork, so their diffs and the coordinator's base describe the same starting tree.
                taskBase = await forkFromMain(dirs[0]);
                for (const dir of dirs.slice(1)) {
                    await git(dir, ["fetch", "--quiet", "origin", "main"]);
                    await git(dir, ["reset", "--quiet", "--hard", taskBase]);
                }
                await client.setTaskBase(repoId, t.id, taskBase);
            };
            const launch = async (wt, extra) => {
                const env = {
                    COMMONS_URL: server.url,
                    ...(cfg.coordinatorToken ? { COMMONS_TOKEN: cfg.coordinatorToken } : {}),
                    ...(cfg.llmResolve ? { COMMONS_LLM_RESOLVE: "1" } : {}),
                    COMMONS_REPO: repoId,
                    COMMONS_TASK: t.id,
                    COMMONS_HOST: host.url,
                    COMMONS_ARM: mode === "queue" ? "queue" : arm,
                    COMMONS_WORKTREE: wt,
                    ...(extra.candidateFile ? { COMMONS_CANDIDATE_FILE: extra.candidateFile } : {}),
                    // Claude Code cuts an MCP tool call at five minutes by default; the cap is thirty. A verdict wait or a
                    // verification on a heavy suite must never be the thing that ends an agent's turn.
                    MCP_TOOL_TIMEOUT: "1800000",
                    // Arm-scoped environment, passed explicitly so it reaches the MCP server and its pre-verification runs.
                    ...(process.env.COMMONS_CHECK_SLOTS ? { COMMONS_CHECK_SLOTS: process.env.COMMONS_CHECK_SLOTS } : {}),
                    ...(cfg.isolateTmp && process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
                    ...(detach ? { COMMONS_DETACH: "1" } : {}),
                    // Pre-verification runs exactly the executor's first gate: the related template only when the executor
                    // gates on related tests, otherwise the full command, so a verdict stored at submit means what the queue
                    // would have computed.
                    ...(cfg.preverify
                        ? {
                            COMMONS_PREVERIFY: "1",
                            COMMONS_TEST_COMMAND: cfg.checks.test,
                            ...(useRelated && cfg.checks.related ? { COMMONS_RELATED_COMMAND: cfg.checks.related } : {}),
                            COMMONS_CHECK_CACHE: join(out, "cache.sqlite"),
                            ...(cfg.executor?.checkTimeoutMs ? { COMMONS_PREVERIFY_TIMEOUT_MS: String(cfg.executor.checkTimeoutMs) } : {}),
                        }
                        : {}),
                };
                const command = (cfg.mcpCommand ?? mcpCommandFor)(t.id, wt, repoId);
                const mcp = { ...command, args: [...command.args, ...(mode === "queue" ? ["--tools", "submit,status"] : [])], env };
                writeFileSync(join(wt, ".mcp.json"), JSON.stringify(mcpConfigFor(mcp), null, 2) + "\n");
                let settingsPath;
                if (mode === "full" && cfg.agent === "claude" && cfg.hooks !== false) {
                    if (launchDir) {
                        settingsPath = join(launchDir, "claude-settings.json");
                        writeFileSync(settingsPath, JSON.stringify(claudeHookSettings(), null, 2) + "\n");
                    }
                    else {
                        mkdirSync(join(wt, ".claude"), { recursive: true });
                        writeFileSync(join(wt, ".claude", "settings.json"), JSON.stringify(claudeHookSettings(), null, 2) + "\n");
                    }
                }
                const prompt = extra.resume
                    ? extra.resume.prompt
                    : (mode === "queue" ? queuePrompt : commonsPrompt)({ taskId: t.id, title: t.title, body: t.body, relatedCommand, testCommand: cfg.checks.test, maxResubmits: cfg.maxResubmits, ...(launchDir ? { worktree: wt } : {}), ...(await promptExtras(t, wt)) });
                if (job.attempt === 0 && cfg.forkFrom !== "main")
                    await warmup();
                log(extra.resume ? `agent ${t.id} resuming after a bounce (${job.attempt}/${maxResumes})` : `agent ${t.id}${extra.candidateFile ? ` candidate ${extra.logName ?? ""}` : ""} starting (${cfg.agent})`);
                return runAgent({
                    kind: cfg.agent,
                    taskId: t.id,
                    cwd: launchDir ?? wt,
                    ...(settingsPath ? { settingsPath } : {}),
                    prompt,
                    mcp,
                    ...(extra.resume?.sessionId ? { resumeSessionId: extra.resume.sessionId } : {}),
                    ...(extra.logName ? { logName: extra.logName } : {}),
                    ...(cfg.model ? { model: cfg.model } : {}),
                    ...(cfg.maxTurns !== undefined ? { maxTurns: cfg.maxTurns } : {}),
                    ...(cfg.maxBudgetUsd !== undefined ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
                    timeoutMs,
                    env: {
                        ...(cfg.agent === "fake" ? { ...env, COMMONS_TASK_BODY: t.body } : env),
                        ...(extra.resume ? { COMMONS_RESUME: "1", COMMONS_RESUME_PROMPT: extra.resume.prompt } : {}),
                    },
                    logDir,
                });
            };
            let run;
            if (bestOf > 1 && job.attempt === 0 && detach && mode === "full") {
                // Best-of-N: N attempts in N worktrees, each recording its commit as a candidate; verification picks one.
                const dirs = [worktree];
                for (let i = 1; i < bestOf; i++) {
                    const dir = await createWorktree(host.url, join(out, "worktrees", `${t.id}~${i}`), baseCommit, t.id, {
                        ...(cfg.nodeModules ? { nodeModules: cfg.nodeModules } : {}),
                        ...(cfg.cowFrom ? { cowFrom: cfg.cowFrom } : {}),
                        meta: { repoId, coordinatorUrl: server.url, hostUrl: host.url, arm },
                    });
                    if (cfg.prepareCheckout)
                        await cfg.prepareCheckout(dir);
                    dirs.push(dir);
                }
                const files = dirs.map((_, i) => join(out, "candidates", `${t.id}.${i}.json`));
                await readyToLaunch(dirs);
                const runs = await Promise.all(dirs.map((dir, i) => launch(dir, { candidateFile: files[i], logName: `${t.id}.v${i}` })));
                segments.set(t.id, [...(segments.get(t.id) ?? []), ...runs]);
                const candidates = dirs.map((dir, i) => {
                    try {
                        const rec = JSON.parse(readFileSync(files[i], "utf8"));
                        return { index: i, worktree: dir, commit: rec.commit, summary: rec.summary ?? "" };
                    }
                    catch {
                        return { index: i, worktree: dir, commit: null, summary: "" };
                    }
                });
                const picked = await selectCandidate(candidates, {
                    base: taskBase,
                    testCommand: cfg.checks.test,
                    ...(useRelated && cfg.checks.related ? { relatedTemplate: cfg.checks.related } : {}),
                    ...(cfg.executor?.checkTimeoutMs ? { timeoutMs: cfg.executor.checkTimeoutMs } : {}),
                    scratch: join(out, "cross"),
                    log: (l) => log(`best-of ${t.id}: ${l}`),
                    // Recorded like pre-verification at submit: under the commit's tree and its closure key, so the integrator
                    // knows the candidate it is handed passed its related check (and can land it optimistically).
                    onOwnCheck: async (candidate, files, own) => {
                        if (!candidate.commit)
                            return;
                        const tree = await git(candidate.worktree, ["rev-parse", `${candidate.commit}^{tree}`]);
                        const result = { id: "related", passed: own.passed, failedTests: own.failed, excerpt: own.excerpt, durationMs: own.durationMs, cached: false };
                        const key = closureKey({ checkId: "related", changedFiles: files, index: closureIndex(candidate.worktree), blobs: await blobsOf(candidate.worktree, tree) });
                        const cache = new CheckCache(cacheSql, { client, repoId });
                        if (key)
                            await cache.publish(key, "related", result);
                        cache.put(tree, "related", result);
                    },
                });
                bestOfScores.set(t.id, picked.scores);
                const winner = picked.winner;
                run = runs[winner?.index ?? 0];
                if (winner?.commit) {
                    worktree = winner.worktree;
                    worktrees.set(t.id, winner.worktree);
                    try {
                        await git(winner.worktree, ["push", "--quiet", "--force", host.url, `${winner.commit}:refs/tasks/${t.id}`]);
                        await git(winner.worktree, ["fetch", "--quiet", host.url, "main"]);
                        const parentMain = await git(winner.worktree, ["merge-base", winner.commit, "FETCH_HEAD"]);
                        await client.submit(repoId, t.id, { commit: winner.commit, parentMain, summary: winner.summary || `${t.title} (best of ${bestOf})` });
                        log(`best-of ${t.id}: submitted candidate ${winner.index} (${winner.commit.slice(0, 8)})`);
                    }
                    catch (error) {
                        log(`best-of ${t.id}: submitting candidate ${winner.index} failed: ${error.message}`);
                    }
                }
                else
                    log(`best-of ${t.id}: no candidate committed anything`);
            }
            else {
                await readyToLaunch([worktree]);
                run = await launch(worktree, { ...(job.resume ? { resume: job.resume } : {}), ...(job.attempt > 0 ? { logName: `${t.id}.resume${job.attempt}` } : {}) });
                segments.set(t.id, [...(segments.get(t.id) ?? []), run]);
            }
            log(`agent ${t.id} finished: exit ${run.exitCode}${run.timedOut ? " (timeout)" : ""} after ${(run.durationMs / 1000).toFixed(1)} s`);
            const limit = usageLimitOf(run);
            if (limit) {
                if (!exhausted)
                    log(`agent ${t.id} hit the account's usage limit (${limit}); no further agents start`);
                exhausted ??= limit;
                return;
            }
            // An agent that exits without ever submitting would block its dependents forever: give the task up.
            try {
                const status = await client.taskStatus(repoId, t.id);
                if (status.submissions.length === 0 && status.task.status !== "landed" && status.task.status !== "abandoned") {
                    await client.abandon(repoId, t.id, "agent exited without submitting");
                    log(`agent ${t.id} exited without submitting; task abandoned`);
                }
            }
            catch (error) {
                log(`agent ${t.id}: could not check or abandon: ${error.message}`);
            }
            if (!detach)
                return;
            // The slot is free; the verdict is awaited with no agent running, and a bounce resumes the session.
            later((async () => {
                const waitedFrom = Date.now();
                const verdict = await waitForVerdict(client, repoId, t.id, cfg.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS, detachedPollMs).catch((error) => {
                    log(`agent ${t.id}: could not wait for the verdict: ${error.message}`);
                    return null;
                });
                verdictWaits.set(t.id, (verdictWaits.get(t.id) ?? 0) + (Date.now() - waitedFrom));
                if (!verdict) {
                    log(`agent ${t.id}: no verdict to act on (${run.resultText ? run.resultText.split(/\r?\n/)[0] : "no result"})`);
                    return undefined;
                }
                if (verdict.status === "landed") {
                    log(`agent ${t.id}: landed as ${verdict.id} after ${((Date.now() - waitedFrom) / 1000).toFixed(1)} s`);
                    return undefined;
                }
                if (job.attempt >= maxResumes) {
                    log(`agent ${t.id}: bounced (${verdict.id}) after ${job.attempt} resume(s); giving up`);
                    return undefined;
                }
                const rendered = renderVerdict(verdict, undefined, mode === "full");
                const canResume = cfg.agent === "claude" && Boolean(run.sessionId);
                const text = resumePrompt({
                    taskId: t.id,
                    verdict: rendered,
                    withDelta: mode === "full",
                    remaining: maxResumes - job.attempt - 1,
                    ...(canResume ? {} : { original: (mode === "queue" ? queuePrompt : commonsPrompt)({ taskId: t.id, title: t.title, body: t.body, relatedCommand, testCommand: cfg.checks.test, maxResubmits: cfg.maxResubmits, ...(launchDir ? { worktree } : {}), detach: true, ...(hooksOn && cfg.lean ? { deltaViaHook: true } : {}), ...(cfg.trustQueue ? { trustQueue: true } : {}) }) }),
                    ...(launchDir ? { worktree } : {}),
                });
                log(`agent ${t.id}: bounced (${verdict.id}); resuming`);
                return { task: t, attempt: job.attempt + 1, resume: { ...(canResume ? { sessionId: run.sessionId } : {}), prompt: text } };
            })());
        }, (error, job) => {
            // One agent's failure (a coordinator request that kept failing, a worktree that could not be created) must not
            // end every other agent's work.
            log(`agent ${job?.task.id ?? "(follow-up)"}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        });
        if (bestOfScores.size > 0)
            writeFileSync(join(out, "best-of.json"), JSON.stringify(Object.fromEntries(bestOfScores), null, 2) + "\n");
        if (exhausted)
            throw new UsageLimitError(exhausted, arm);
        const agents = tasks.map((t) => mergeRuns(segments.get(t.id) ?? [], verdictWaits.get(t.id) ?? 0));
        await waitForDrain(client, repoId, cfg.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS, log);
        abort.abort();
        const { executorCostUsd } = await executor;
        executor = undefined;
        const finalMain = await git(host.url, ["rev-parse", "--verify", "refs/heads/main^{commit}"]);
        const events = await allEvents(client, repoId);
        const counts = bounceCounts(events);
        const official = cfg.official ? await cfg.official(finalMain) : undefined;
        const taskReports = [];
        for (const t of tasks) {
            const status = await client.taskStatus(repoId, t.id);
            const c = counts.get(t.id) ?? { bounces: 0, conflicts: 0 };
            const tr = {
                id: t.id,
                title: t.title,
                landed: status.task.status === "landed",
                bounces: c.bounces,
                conflicts: c.conflicts,
                status: status.task.status,
                submissions: status.submissions.length,
            };
            if (official && t.id in official)
                tr.official = official[t.id];
            taskReports.push(tr);
        }
        const suite = await runFinalSuite(out, host.url, finalMain, cfg.checks.test, {
            ...(cfg.cowFrom ? { cowFrom: cfg.cowFrom } : {}),
            ...(cfg.nodeModules ? { nodeModules: cfg.nodeModules } : {}),
            ...(cfg.prepareCheckout ? { prepareCheckout: cfg.prepareCheckout } : {}),
            ...(cfg.executor?.checkTimeoutMs ? { timeoutMs: cfg.executor.checkTimeoutMs } : {}),
        });
        const metrics = await client.metrics(repoId);
        const endedAt = Date.now();
        const report = {
            arm,
            agent: cfg.agent,
            ...(cfg.model ? { model: cfg.model } : {}),
            concurrency: cfg.agents,
            admission,
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
            executorCostUsd,
            systemCostUsd: systemCost({ agents, executorCostUsd }),
            metrics,
            events,
            ...(official ? { official } : {}),
        };
        writeReports(out, report);
        log(`done: ${taskReports.filter((t) => t.landed).length}/${taskReports.length} landed, final suite ${suite.passed === null ? "n/a" : suite.passed ? "pass" : "fail"}`);
        return report;
    }
    finally {
        abort.abort();
        if (executor)
            await executor.catch(() => undefined);
        cacheSql.close();
        await server.close();
    }
}
//# sourceMappingURL=run.js.map