// CLI: run the context-migration workload (date-fns, K functions gaining the `in` option, with dependencies between
// tasks) through the commons, queue and/or baseline arms.
//
//   node --import tsx src/bench/context/run.ts --k 16 --seed 1 --arm both --agents 16 --agent claude --model sonnet \
//     [--functions a,b,c] [--admission none|dependencies|overlaps|pipeline|declared] [--window N|auto] [--batch N] [--related-gate] \
//     [--llm-resolve [model]] [--max-turns N] [--max-resubmits N] [--max-budget-usd B] [--timeout-min M] [--out DIR] [--baseline-first] [--no-official]
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { benchRoot } from "../issues/prepare.js";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "../../executor/git.js";
import { renderReport } from "../../runner/report.js";
import { runSwarm } from "../../runner/run.js";
import { maxResubmitsOption, selectArms } from "../arms.js";
import { scoreScale } from "../scale/official.js";
import { prepareContext } from "./prepare.js";
function usage() {
    return [
        "usage: node --import tsx src/bench/context/run.ts --k N --seed S --arm commons|queue|baseline|both|all [--agents N]",
        "         --agent claude|codex|fake [--model M] [--functions a,b,c] [--out DIR] [--admission none|dependencies|overlaps|pipeline|declared]",
        "         [--window N|auto] [--batch N] [--llm-resolve [model]] [--max-turns N] [--max-resubmits N] [--max-budget-usd B] [--timeout-min M]",
        "         [--baseline-first] [--no-official] [--contracts]",
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
            k: { type: "string", default: "16" },
            seed: { type: "string", default: "1" },
            functions: { type: "string" },
            arm: { type: "string", default: "both" },
            agents: { type: "string" },
            agent: { type: "string", default: "claude" },
            model: { type: "string" },
            out: { type: "string" },
            admission: { type: "string", default: "pipeline" },
            contracts: { type: "boolean", default: false },
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
    const k = integer("k", values.k);
    const seed = integer("seed", values.seed);
    const arms = selectArms(values.arm, values["baseline-first"]);
    const maxResubmits = maxResubmitsOption(values["max-resubmits"]);
    const agent = oneOf("agent", values.agent, ["claude", "codex", "fake"]);
    const admission = oneOf("admission", values.admission, ["none", "dependencies", "overlaps", "pipeline", "declared"]);
    const timeoutMs = integer("timeout-min", values["timeout-min"]) * 60 * 1000;
    const maxTurns = values["max-turns"] !== undefined ? integer("max-turns", values["max-turns"]) : undefined;
    const maxBudgetUsd = values["max-budget-usd"] !== undefined ? Number(values["max-budget-usd"]) : undefined;
    const batchSize = values.batch !== undefined ? integer("batch", values.batch) : undefined;
    const functions = values.functions ? values.functions.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const workload = await prepareContext({ k, seed, ...(functions ? { functions } : {}) });
    const tasks = workload.set.tasks;
    const agents = values.agents !== undefined ? integer("agents", values.agents) : tasks.length;
    const label = functions ? `context-${tasks.length}` : `context-k${k}-s${seed}`;
    const out = resolve(values.out ?? benchRoot("bench", `${label}-${agent}-${stamp()}`));
    mkdirSync(out, { recursive: true });
    // The full suite runs in ~4 s, so the executor runs it as the only check; agents get `vitest related` for local iteration.
    const checks = { test: workload.testCommand, related: workload.relatedCommand };
    const edges = Object.entries(workload.set.dependencies).filter(([, d]) => d.length).map(([f, d]) => `${f}->${d.join("+")}`);
    console.error(`[bench] dependencies: ${edges.length ? edges.join(" ") : "none"}`);
    console.error(`[bench] ${label}: ${tasks.length} tasks (${workload.set.functions.join(" ")}), arms ${arms.join(" then ")}, ${agents} ${agent} agents, base ${workload.set.baseCommit.slice(0, 12)}, out ${out}`);
    const reports = [];
    for (const arm of arms) {
        const armOut = join(out, arm);
        const hostGit = join(armOut, "host.git");
        const official = values["no-official"]
            ? undefined
            : async (finalMain) => {
                const src = join(armOut, "official-src");
                if (!existsSync(join(src, ".git")))
                    await git(armOut, ["clone", "--quiet", hostGit, src]);
                await git(src, ["fetch", "--quiet", hostGit, "+refs/heads/main:refs/remotes/host/main"]);
                const results = await scoreScale({
                    repo: src,
                    commit: finalMain,
                    functions: workload.set.functions,
                    hiddenDir: workload.set.hiddenDir,
                    nodeModules: workload.nodeModules,
                    out: join(armOut, "official"),
                    barrelCheck: false,
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
            repoId: label,
            executor: { relatedCheck: values["related-gate"] === true, fullSuitePerBatch: values["related-gate"] !== true, ...(values.integrators ? { integrators: integer("integrators", values.integrators) } : {}), ...(batchSize !== undefined ? { batchSize } : {}) },
            ...(values["llm-resolve"] !== undefined ? { llmResolve: { model: values["llm-resolve"] || "sonnet" } } : {}),
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