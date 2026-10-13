// CLI: run the React Hook Form workload through the commons, queue and/or baseline arms and write a summary.
//
//   node --import tsx src/bench/rhf/run.ts --task task153 --arm commons|queue|baseline|both|all --agents 6 \
//     --agent claude|codex|fake [--model <m>] --out <dir> [--admission none|dependencies|overlaps|pipeline|declared] \
//     [--max-turns N] [--max-resubmits N] [--timeout-min M] [--features feature1,feature2,...] [--baseline-first] [--no-official] [--no-replay]
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { benchRoot } from "../issues/prepare.js";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "../../executor/git.js";
import { renderReport } from "../../runner/report.js";
import { runSwarm } from "../../runner/run.js";
import { maxResubmitsOption, selectArms } from "../arms.js";
import { officialScore } from "./official.js";
import { prepareRhf } from "./prepare.js";
function usage() {
    return [
        "usage: node --import tsx src/bench/rhf/run.ts --task task153|task85 --arm commons|queue|baseline|both|all --agents N",
        "         --agent claude|codex|fake [--model M] [--out DIR] [--admission none|dependencies|overlaps|pipeline|declared]",
        "         [--max-turns N] [--max-resubmits N] [--max-budget-usd B] [--timeout-min M] [--features feature1,feature2,...]",
        "         [--baseline-first] [--no-official] [--contracts] [--no-replay]",
    ].join("\n");
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
export async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            task: { type: "string", default: "task153" },
            arm: { type: "string", default: "both" },
            agents: { type: "string", default: "6" },
            agent: { type: "string", default: "claude" },
            model: { type: "string" },
            out: { type: "string" },
            admission: { type: "string", default: "none" },
            contracts: { type: "boolean", default: false },
            window: { type: "string" },
            "llm-resolve": { type: "string" },
            "no-replay": { type: "boolean", default: false },
            "max-turns": { type: "string" },
            "max-resubmits": { type: "string" },
            "max-budget-usd": { type: "string" },
            "timeout-min": { type: "string", default: "30" },
            features: { type: "string" },
            "baseline-first": { type: "boolean", default: false },
            "no-official": { type: "boolean", default: false },
            "shared-cwd": { type: "boolean", default: false },
            preverify: { type: "boolean", default: false },
            detach: { type: "boolean", default: false },
            lean: { type: "boolean", default: false },
            "trust-queue": { type: "boolean", default: false },
            "check-slots": { type: "string" },
            "warmup-ms": { type: "string" },
            integrators: { type: "string" },
            "prune-after-arm": { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
    });
    if (values.help) {
        console.log(usage());
        return 0;
    }
    const task = oneOf("task", values.task, ["task153", "task85"]);
    const arms = selectArms(values.arm, values["baseline-first"]);
    const maxResubmits = maxResubmitsOption(values["max-resubmits"]);
    const agent = oneOf("agent", values.agent, ["claude", "codex", "fake"]);
    const admission = oneOf("admission", values.admission, ["none", "dependencies", "overlaps", "pipeline", "declared"]);
    const agents = integer("agents", values.agents);
    const timeoutMs = integer("timeout-min", values["timeout-min"]) * 60 * 1000;
    const maxTurns = values["max-turns"] !== undefined ? integer("max-turns", values["max-turns"]) : undefined;
    const maxBudgetUsd = values["max-budget-usd"] !== undefined ? Number(values["max-budget-usd"]) : undefined;
    const out = resolve(values.out ?? benchRoot("bench", `${task}-${agent}-${stamp()}`));
    mkdirSync(out, { recursive: true });
    const workload = await prepareRhf(task);
    const wanted = values.features ? new Set(values.features.split(",").map((s) => s.trim()).filter(Boolean)) : null;
    const selected = workload.set.tasks.filter((t) => !wanted || wanted.has(t.id));
    if (selected.length === 0)
        throw new Error(`no tasks selected (available: ${workload.set.tasks.map((t) => t.id).join(", ")})`);
    const tasks = selected.map((t) => ({ id: t.id, title: t.title, body: t.body }));
    const featureIds = tasks.map((t) => t.id);
    // The full suite runs in ~5 s here, so the executor skips the separate related-tests pass (see executor.relatedCheck);
    // agents still get the related command in their prompt for local iteration.
    const checks = { test: workload.testCommand, related: workload.relatedCommand };
    console.error(`[bench] ${task}: ${tasks.length} tasks, arms ${arms.join(" then ")}, ${agents} ${agent} agents, out ${out}`);
    const reports = [];
    for (const arm of arms) {
        const armOut = join(out, arm);
        const hostGit = join(armOut, "host.git");
        const official = values["no-official"]
            ? undefined
            : async (finalMain) => {
                // A fresh clone of the host carries both the base and the final main for `git diff`.
                const src = join(armOut, "official-src");
                if (!existsSync(join(src, ".git")))
                    await git(armOut, ["clone", "--quiet", hostGit, src]);
                await git(src, ["fetch", "--quiet", hostGit, "+refs/heads/main:refs/remotes/host/main"]);
                const results = await officialScore({
                    repo: src,
                    commit: finalMain,
                    base: workload.set.baseCommit,
                    image: workload.set.image,
                    datasetDir: workload.set.datasetDir,
                    features: featureIds,
                    out: join(armOut, "official"),
                });
                return Object.fromEntries(results.map((r) => [r.feature, r.passed]));
            };
        const cfg = {
            repo: workload.repoDir,
            tasks,
            agents,
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
            ...(values["trust-queue"] ? { trustQueue: true } : {}),
            ...(values["check-slots"] !== undefined ? { checkSlots: Number(values["check-slots"]) } : {}),
            ...(values["warmup-ms"] ? { warmupMs: Number(values["warmup-ms"]) } : {}),
            contracts: values.contracts,
            ...(values.window ? { window: values.window === "auto" ? "auto" : Number(values.window) } : {}),
            checks,
            nodeModules: workload.nodeModules,
            repoId: `rhf-${task}`,
            executor: { relatedCheck: false, ...(values.integrators ? { integrators: integer("integrators", values.integrators) } : {}) },
            ...(values["llm-resolve"] !== undefined ? { llmResolve: { model: values["llm-resolve"] || "sonnet" } } : {}),
            ...(values["no-replay"] ? { replay: false } : {}),
            ...(official ? { official } : {}),
        };
        const report = await runSwarm(cfg);
        reports.push(report);
        if (values["prune-after-arm"]) {
            // Worktrees, the executor's clone and the final checkout are not needed once the arm's report and official
            // scoring are written; host.git, logs and reports stay. Keeps a 3-arm run of a large repo within disk.
            for (const sub of ["worktrees", "work", "final", "official-src", join("official", "checkout")])
                rmSync(join(armOut, sub), { recursive: true, force: true });
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