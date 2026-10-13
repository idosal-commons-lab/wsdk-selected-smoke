// CLI: run the issues workload (merged pull requests of a real repository, replayed as concurrent tasks with their
// hidden tests) through the commons, queue, github and/or baseline arms. Collect a set first with src/bench/issues/collect.ts.
//
//   node --import tsx src/bench/issues/run.ts --set bench/issues/workers-sdk.json --arm all --agents 25 --agent claude --model sonnet \
//     [--tasks pr1,pr2] [--admission none|dependencies|overlaps|pipeline|declared] [--window N|auto] [--batch N] [--related-gate] \
//     [--llm-resolve [model]] [--max-turns N] [--max-resubmits N] [--max-budget-usd B] [--timeout-min M] [--out DIR] [--baseline-first] [--no-official] [--fork-from base|main] [--arrival-ms N]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { benchRoot } from "../issues/prepare.js";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "../../executor/git.js";
import { renderReport } from "../../runner/report.js";
import { runSwarm } from "../../runner/run.js";
import { maxResubmitsOption, selectArms } from "../arms.js";
import { scoreIssues } from "./official.js";
import { prepareIssues } from "./prepare.js";
function usage() {
    return [
        "usage: node --import tsx src/bench/issues/run.ts --set bench/issues/<repo>.json --arm commons|queue|github|baseline|both|all|three [--agents N]",
        "         all = commons,queue,baseline; three = commons,github,baseline",
        "         --agent claude|codex|fake [--model M] [--tasks pr1,pr2] [--out DIR] [--admission none|dependencies|overlaps|pipeline|declared]",
        "         [--window N|auto] [--batch N] [--llm-resolve [model]] [--max-turns N] [--max-resubmits N] [--max-budget-usd B] [--timeout-min M]",
        "         [--baseline-first] [--no-official] [--shared-cwd] [--warmup-ms N] [--integrators N] [--related-gate] [--preverify] [--detach] [--lean] [--trust-queue] [--check-slots N] [--speculate] [--optimistic] [--max-risk N] [--hints] [--best-of N]",
        "         [--validate-base] [--prune-after-arm] [--no-cow]",
        "         [--fork-from base|main] [--arrival-ms N] [--replay <trace dir>] [--replay-scale F] [--prefetch N]",
    ].join("\n");
}
/**
 * How long one CI run of the github arm may take. workers-sdk's test job times out at 30 minutes on a runner that runs
 * nothing else; here a merge group's CI shares the machine with eight agents and the other check slots, and a change
 * to miniflare re-runs the full suites of 19 packages. A slow pass must not become a failure: generous to GitHub.
 */
export const GITHUB_CI_TIMEOUT_MS = 120 * 60 * 1000;
/** GitHub's agent side is the queue arm; its merge groups always wait for full affected-package CI. */
export function issuesArmConfig(cfg, ciCommand) {
    if (cfg.arm !== "github")
        return cfg;
    return {
        ...cfg,
        drainTimeoutMs: Math.max(cfg.drainTimeoutMs ?? 0, GITHUB_CI_TIMEOUT_MS + 5 * 60 * 1000),
        mode: "queue",
        checks: { ...cfg.checks, related: ciCommand },
        preverify: false,
        hints: false,
        closureKeys: false,
        structuredMerge: false,
        replay: false,
        llmResolve: undefined,
        bestOf: undefined,
        executor: {
            ...cfg.executor,
            batchSize: cfg.executor?.batchSize ?? 5,
            checkTimeoutMs: Math.max(cfg.executor?.checkTimeoutMs ?? 0, GITHUB_CI_TIMEOUT_MS),
            relatedCheck: true,
            fullSuitePerBatch: false,
            speculate: false,
            optimistic: false,
            // Parallel integrators retain affinity for disjoint groups; GitHub cannot land these in parallel, so this
            // is deliberately generous to GitHub, with the same machine and check slots as the other arms.
        },
    };
}
function oneOf(name, value, allowed) {
    if (!allowed.includes(value))
        throw new Error(`--${name} must be one of ${allowed.join("|")}, got ${value}`);
    return value;
}
function integer(name, value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0)
        throw new Error(`--${name} must be a positive integer, got ${value}`);
    return n;
}
function stamp() {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}
/**
 * Deleting a pruned checkout took about a minute per workers-sdk clone (172k files), in process, so the next arm waited
 * half an hour for the last one's clones. They are moved into a trash directory (a rename, instant) and deleted by a
 * detached low-priority process.
 */
function discard(path) {
    if (!existsSync(path))
        return;
    const trash = benchRoot(".trash");
    mkdirSync(trash, { recursive: true });
    try {
        renameSync(path, join(trash, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`));
    }
    catch {
        rmSync(path, { recursive: true, force: true });
    }
}
function emptyTrash() {
    const trash = benchRoot(".trash");
    if (!existsSync(trash))
        return;
    const child = spawn("nice", ["-n", "15", "rm", "-rf", trash], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
}
export async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            set: { type: "string", default: "bench/issues/workers-sdk.json" },
            tasks: { type: "string" },
            arm: { type: "string", default: "both" },
            agents: { type: "string" },
            agent: { type: "string", default: "claude" },
            model: { type: "string" },
            out: { type: "string" },
            admission: { type: "string", default: "none" },
            window: { type: "string" },
            batch: { type: "string" },
            "related-gate": { type: "boolean", default: false },
            "llm-resolve": { type: "string" },
            "max-turns": { type: "string" },
            "max-resubmits": { type: "string" },
            "max-budget-usd": { type: "string" },
            "timeout-min": { type: "string", default: "30" },
            "baseline-first": { type: "boolean", default: false },
            "no-official": { type: "boolean", default: false },
            "shared-cwd": { type: "boolean", default: false },
            preverify: { type: "boolean", default: false },
            detach: { type: "boolean", default: false },
            lean: { type: "boolean", default: false },
            hints: { type: "boolean", default: false },
            "best-of": { type: "string" },
            "trust-queue": { type: "boolean", default: false },
            "check-slots": { type: "string" },
            speculate: { type: "boolean", default: false },
            optimistic: { type: "boolean", default: false },
            "max-risk": { type: "string" },
            "warmup-ms": { type: "string" },
            "fork-from": { type: "string", default: "base" },
            replay: { type: "string" },
            prefetch: { type: "string" },
            "replay-scale": { type: "string", default: "1" },
            "arrival-ms": { type: "string", default: "0" },
            integrators: { type: "string" },
            "prune-after-arm": { type: "boolean", default: false },
            "validate-base": { type: "boolean", default: false },
            "no-cow": { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(usage());
        return 0;
    }
    const arms = selectArms(values.arm, values["baseline-first"]);
    const maxResubmits = maxResubmitsOption(values["max-resubmits"]);
    const forkFrom = oneOf("fork-from", values["fork-from"], ["base", "main"]);
    const arrivalMs = Number(values["arrival-ms"]);
    if (!/^\d+$/.test(values["arrival-ms"]) || !Number.isSafeInteger(arrivalMs))
        throw new Error("--arrival-ms must be a non-negative integer");
    // Replay (src/bench/replay/trace.ts): the fake agent resubmits a recorded run's changes with its timing, so arms
    // and concurrencies are compared on identical work.
    const agent = values.replay ? "fake" : oneOf("agent", values.agent, ["claude", "codex", "fake"]);
    const replayScale = Number(values["replay-scale"]);
    if (!(replayScale >= 0))
        throw new Error("--replay-scale must be a non-negative number");
    const admission = oneOf("admission", values.admission, ["none", "dependencies", "overlaps", "pipeline", "declared"]);
    const timeoutMs = integer("timeout-min", values["timeout-min"]) * 60 * 1000;
    const maxTurns = values["max-turns"] !== undefined ? integer("max-turns", values["max-turns"]) : undefined;
    const maxBudgetUsd = values["max-budget-usd"] !== undefined ? Number(values["max-budget-usd"]) : undefined;
    const batchSize = values.batch !== undefined ? integer("batch", values.batch) : undefined;
    const wanted = values.tasks ? new Set(values.tasks.split(",").map((s) => s.trim()).filter(Boolean)) : null;
    const workload = await prepareIssues({ setPath: resolve(values.set), ciBase: arms.includes("github") });
    Object.assign(process.env, workload.env); // agents, executor checks and scoring share the turbo cache and pnpm store
    let tasks = workload.tasks.filter((t) => !wanted || wanted.has(t.id));
    if (tasks.length === 0)
        throw new Error("no tasks selected");
    if (values.replay) {
        const tracePath = join(resolve(values.replay), "trace.json");
        const trace = JSON.parse(readFileSync(tracePath, "utf8"));
        const base = await git(workload.repoDir, ["rev-parse", "HEAD"]);
        if (trace.base !== base)
            throw new Error(`the trace was recorded on ${trace.base.slice(0, 12)}, the workload's base is ${base.slice(0, 12)}`);
        tasks = tasks.filter((t) => trace.tasks[t.id]).map((t) => ({ ...t, body: `FAKE: replay ${tracePath}` }));
        process.env.COMMONS_REPLAY_SCALE = String(replayScale);
    }
    if (values["validate-base"]) {
        // Fail-to-pass, half of it: a task whose hidden tests already pass on the base is not a task. (The other half,
        // that the real fix passes them, is the PR's own CI.)
        const baseHead = await git(workload.repoDir, ["rev-parse", "HEAD"]);
        const results = await scoreIssues({
            repo: workload.repoDir,
            commit: baseHead,
            set: { ...workload.set, tasks: workload.set.tasks.filter((t) => tasks.some((x) => x.id === t.id)) },
            hiddenDir: workload.hiddenDir,
            env: workload.env,
            prepareCheckout: workload.prepareCheckout,
            out: join(resolve(values.out ?? benchRoot("bench", "issues-validate")), "validate-base"),
        });
        const passing = results.filter((r) => r.passed).map((r) => r.feature);
        const broken = results.filter((r) => !r.passed && r.error && !r.failedNames.length).map((r) => `${r.feature} (${(r.error ?? "").slice(0, 80)})`);
        console.error(`[bench] base validation: ${results.length - passing.length}/${results.length} hidden test sets fail on the base${passing.length ? `; excluded (already pass): ${passing.join(", ")}` : ""}${broken.length ? `; could not run: ${broken.join("; ")}` : ""}`);
        tasks = tasks.filter((t) => !passing.includes(t.id));
        if (tasks.length === 0)
            throw new Error("no task survives base validation");
    }
    const agents = values.agents !== undefined ? integer("agents", values.agents) : tasks.length;
    const label = `issues-${workload.set.repo.split("/")[1]}-${tasks.length}`;
    const out = resolve(values.out ?? benchRoot("bench", `${label}-${agent}-${stamp()}`));
    mkdirSync(out, { recursive: true });
    // The full suite runs in ~4 s, so the executor runs it as the only check; agents get `vitest related` for local iteration.
    const checks = { test: workload.testCommand, related: workload.relatedCommand };
    console.error(`[bench] ${label}: ${tasks.length} tasks (${tasks.map((t) => t.id).join(" ")}), arms ${arms.join(" then ")}, ${agents} ${agent} agents, base ${workload.set.baseCommit.slice(0, 12)}, out ${out}`);
    const reports = [];
    for (const arm of arms) {
        const armOut = join(out, arm);
        const hostGit = join(armOut, "host.git");
        const official = values["no-official"]
            ? undefined
            : async (finalMain) => {
                if (values["prune-after-arm"]) {
                    // The agents are done: their worktrees and the executor's clone are not needed for scoring, and a
                    // monorepo checkout with its dependencies is large. Free them before the scoring checkout is created.
                    for (const sub of ["worktrees", "work"])
                        discard(join(armOut, sub));
                    console.error(`[bench] pruned ${arm} worktrees before scoring`);
                }
                const src = join(armOut, "official-src");
                if (!existsSync(join(src, ".git")))
                    await git(armOut, ["clone", "--quiet", hostGit, src]);
                await git(src, ["fetch", "--quiet", hostGit, "+refs/heads/main:refs/remotes/host/main"]);
                const results = await scoreIssues({
                    repo: src,
                    commit: finalMain,
                    set: { ...workload.set, tasks: workload.set.tasks.filter((t) => tasks.some((x) => x.id === t.id)) },
                    hiddenDir: workload.hiddenDir,
                    env: workload.env,
                    prepareCheckout: workload.prepareCheckout,
                    out: join(armOut, "official"),
                });
                // The per-task details (failing test names, errors) are what explains a hidden-test score.
                writeFileSync(join(armOut, "official.json"), JSON.stringify(results, null, 2) + "\n");
                return Object.fromEntries(results.map((r) => [r.feature, r.passed]));
            };
        const cfg = {
            repo: workload.repoDir,
            tasks,
            agents,
            forkFrom,
            arrivalMs,
            ...(values.prefetch !== undefined ? { prefetch: integer("prefetch", values.prefetch) } : {}),
            agent,
            arm,
            mode: arm === "queue" ? "queue" : "full",
            out: armOut,
            ...(values.model ? { model: values.model } : {}),
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ...(maxResubmits !== undefined ? { maxResubmits } : {}),
            ...(maxBudgetUsd !== undefined && Number.isFinite(maxBudgetUsd) ? { maxBudgetUsd } : {}),
            timeoutMs,
            admission,
            ...(values["shared-cwd"] ? { sharedCwd: true } : {}),
            ...(values.preverify ? { preverify: true } : {}),
            ...(values.detach ? { detach: true } : {}),
            ...(values.lean ? { lean: true } : {}),
            ...(values.hints ? { hints: true } : {}),
            ...(values["best-of"] ? { bestOf: integer("best-of", values["best-of"]) } : {}),
            ...(values["trust-queue"] ? { trustQueue: true } : {}),
            ...(values["check-slots"] !== undefined ? { checkSlots: Number(values["check-slots"]) } : {}),
            // Wrangler's and miniflare's suites leave their temp directories behind; each arm gets its own, removed at its end.
            isolateTmp: true,
            // A heavy check can take up to its thirty-minute timeout: stop waiting for the queue only when no verdict at
            // all has arrived for longer than that.
            drainTimeoutMs: 35 * 60 * 1000,
            ...(values["warmup-ms"] ? { warmupMs: Number(values["warmup-ms"]) } : {}),
            ...(values.window ? { window: values.window === "auto" ? "auto" : Number(values.window) } : {}),
            checks,
            prepareCheckout: workload.prepareCheckout,
            // Worktrees and work clones are copy-on-write clones of the installed base: seconds each, blocks shared.
            ...(values["no-cow"] ? {} : { cowFrom: workload.repoDir }),
            repoId: label,
            executor: { relatedCheck: values["related-gate"] === true, fullSuitePerBatch: values["related-gate"] !== true, ...(values.integrators ? { integrators: integer("integrators", values.integrators) } : {}), checkTimeoutMs: 30 * 60 * 1000, ...(batchSize !== undefined ? { batchSize } : {}), ...(values.speculate ? { speculate: true } : {}), ...(values.optimistic ? { optimistic: values["max-risk"] ? { maxRisk: integer("max-risk", values["max-risk"]) } : true } : {}) },
            ...(values["llm-resolve"] !== undefined ? { llmResolve: { model: values["llm-resolve"] || "sonnet" } } : {}),
            ...(official ? { official } : {}),
        };
        const report = await runSwarm(issuesArmConfig(cfg, workload.ciCommand));
        reports.push(report);
        if (values["prune-after-arm"]) {
            // Worktrees, the executor's clone and the final checkout are not needed once the arm's report and official
            // scoring are written; host.git, logs and reports stay. Keeps a 3-arm run of a large repo within disk.
            for (const sub of readdirSync(armOut))
                if (/^(worktrees|work(-\d+)?(-verify(-\d+)?)?|final|official-src)$/.test(sub))
                    discard(join(armOut, sub));
            discard(join(armOut, "official", "checkout"));
            emptyTrash();
            console.error(`[bench] pruned ${arm} clones`);
        }
        writeFileSync(join(out, "summary.md"), renderReport(reports));
        writeFileSync(join(out, "summary.json"), JSON.stringify(reports.map((r) => ({ ...r, events: r.events.length })), null, 2) + "\n");
    }
    const summary = renderReport(reports);
    console.log(summary);
    console.error(`[bench] summary written to ${join(out, "summary.md")}`);
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        console.error(usage());
        process.exit(1);
    });
}
//# sourceMappingURL=run.js.map