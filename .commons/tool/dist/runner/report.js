import { emptyPhases, PHASES, statusLine } from "./agents.js";
export function totals(run) {
    const t = { input: 0, cachedInput: 0, cacheCreation: 0, output: 0, uncachedInput: 0, totalInput: 0, errors: 0 };
    let cost;
    let turns;
    for (const a of run.agents) {
        t.input += a.tokens.input;
        t.cachedInput += a.tokens.cachedInput;
        t.cacheCreation += a.tokens.cacheCreation;
        t.output += a.tokens.output;
        if (a.costUsd !== undefined)
            cost = (cost ?? 0) + a.costUsd;
        if (a.turns !== undefined)
            turns = (turns ?? 0) + a.turns;
        if (a.isError)
            t.errors++;
    }
    t.uncachedInput = t.input + t.cacheCreation;
    t.totalInput = t.input + t.cachedInput + t.cacheCreation;
    if (cost !== undefined)
        t.costUsd = cost;
    if (turns !== undefined)
        t.turns = turns;
    return t;
}
export function systemCost(run) {
    return (totals(run).costUsd ?? 0) + (run.executorCostUsd ?? 0);
}
const fmtInt = (n) => (n === undefined ? "-" : new Intl.NumberFormat("en-US").format(Math.round(n)));
const fmtCost = (n) => (n === undefined ? "-" : `$${n.toFixed(2)}`);
const fmtSeconds = (ms) => (ms / 1000).toFixed(1);
const fmtRatio = (a, b) => a === undefined || b === undefined || b === 0 ? "-" : (a / b).toFixed(2);
const cell = (s) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
function row(cells) {
    return `| ${cells.map(cell).join(" | ")} |`;
}
function table(header, rows) {
    return [row(header), `|${header.map(() => "---").join("|")}|`, ...rows.map(row)].join("\n");
}
function officialCell(run) {
    if (!run.official)
        return "-";
    const ids = run.tasks.map((t) => t.id);
    const passes = ids.filter((id) => run.official[id] === true).length;
    return `${passes}/${ids.length}`;
}
function suiteCell(passed) {
    return passed === null ? "-" : passed ? "pass" : "fail";
}
export function renderReport(runs) {
    const lines = ["# Commons benchmark report", ""];
    const header = [
        "Arm",
        "Agent",
        "Wall (s)",
        "Agents",
        "Landed",
        "Official",
        "Final suite",
        "Input tokens",
        "Uncached input",
        "Cached input",
        "Output",
        "Cost (agents)",
        "Cost (system)",
        "Turns",
        "Bounces",
        "Conflicts",
        "Cache hits",
    ];
    const rows = runs.map((run) => {
        const t = totals(run);
        const landed = run.tasks.filter((x) => x.landed).length;
        return [
            run.arm,
            run.model ? `${run.agent} (${run.model})` : run.agent,
            fmtSeconds(run.wallMs),
            String(run.concurrency),
            `${landed}/${run.tasks.length}`,
            officialCell(run),
            suiteCell(run.finalSuitePassed),
            fmtInt(t.totalInput),
            fmtInt(t.uncachedInput),
            fmtInt(t.cachedInput),
            fmtInt(t.output),
            fmtCost(t.costUsd),
            fmtCost(run.systemCostUsd ?? systemCost(run)),
            fmtInt(t.turns),
            run.metrics ? fmtInt(run.metrics.bounces) : "-",
            run.metrics ? fmtInt(run.metrics.conflicts) : "-",
            run.metrics ? fmtInt(run.metrics.cachedVerdicts) : "-",
        ];
    });
    lines.push(table(header, rows), "");
    for (const run of runs) {
        const detached = run.agents.filter((a) => a.verdictWaitMs !== undefined);
        if (detached.length === 0)
            continue;
        const resumes = detached.reduce((s, a) => s + (a.resumes ?? 0), 0);
        const waitMs = detached.reduce((s, a) => s + (a.verdictWaitMs ?? 0), 0);
        const agentMs = run.agents.reduce((s, a) => s + a.durationMs, 0);
        lines.push(`${run.arm}: detached agents (submit and stop); ${resumes} resume(s) after bounces; verdicts awaited with no agent running for ${fmtSeconds(waitMs)} s in total, on top of ${fmtSeconds(agentMs)} s of agent time.`, "");
    }
    const commons = runs.find((r) => r.arm === "commons");
    const baseline = runs.find((r) => r.arm === "baseline");
    if (commons && baseline) {
        const c = totals(commons);
        const b = totals(baseline);
        const ratios = [`wall ${fmtRatio(commons.wallMs, baseline.wallMs)}`, `uncached input ${fmtRatio(c.uncachedInput, b.uncachedInput)}`];
        if (c.costUsd !== undefined && b.costUsd !== undefined)
            ratios.push(`cost ${fmtRatio(c.costUsd, b.costUsd)}`);
        ratios.push(`system cost ${fmtRatio(commons.systemCostUsd ?? systemCost(commons), baseline.systemCostUsd ?? systemCost(baseline))}`);
        lines.push(`Ratios commons/baseline: ${ratios.join(", ")}`, "");
    }
    for (const run of runs) {
        const phases = emptyPhases();
        for (const agent of run.agents) {
            for (const phase of PHASES) {
                const usage = agent.phases?.[phase]; // Older saved reports may have no phase accounting.
                if (!usage)
                    continue;
                for (const key of ["calls", "ms", "input", "cachedInput", "cacheCreation", "output"])
                    phases[phase][key] += usage[key];
            }
        }
        const uncachedInput = totals(run).uncachedInput;
        lines.push(`## ${run.arm}: phases`, "");
        lines.push(table(["Phase", "Calls", "Wall (s)", "Uncached input", "Output", "% of arm uncached input"], PHASES.map((phase) => {
            const usage = phases[phase];
            const uncached = usage.input + usage.cacheCreation;
            return [phase, fmtInt(usage.calls), fmtSeconds(usage.ms), fmtInt(uncached), fmtInt(usage.output), uncachedInput ? `${(100 * uncached / uncachedInput).toFixed(1)}%` : "0.0%"];
        })), "");
        lines.push("Tool time sums receipt-to-result latencies (parallel calls can overlap); think time is the gap since the previous event. Codex phase tokens are unavailable; fake agents have zero phase usage.", "");
        lines.push(`## ${run.arm}: tasks`, "");
        lines.push(`Base ${run.baseCommit.slice(0, 12)} -> final main ${run.finalMain.slice(0, 12)}; started ${run.startedAt}, ended ${run.endedAt}.`, "");
        const byTask = new Map(run.agents.map((a) => [a.taskId, a]));
        const taskHeader = ["Task", "Landed", "Bounces", "Conflicts", "Official", "Agent exit", "Time (s)", "Turns", "Uncached input", "Cached input", "Output", "Cost (USD)", "Result"];
        const taskRows = run.tasks.map((t) => {
            const a = byTask.get(t.id);
            const exit = a ? (a.timedOut ? "timeout" : a.exitCode === null ? (a.signal ?? "n/a") : String(a.exitCode)) : "-";
            const result = a ? (statusLine(a.resultText) ?? (a.resultText ?? "").trim().slice(0, 80)) : t.blockedBy?.length ? `Blocked by: ${t.blockedBy.join(", ")}` : "";
            return [
                t.id,
                t.landed ? "yes" : "no",
                run.metrics ? String(t.bounces) : "-",
                run.metrics ? String(t.conflicts) : "-",
                t.official === undefined ? "-" : t.official ? "pass" : "fail",
                exit,
                a ? fmtSeconds(a.durationMs) : "-",
                a ? fmtInt(a.turns) : "-",
                a ? fmtInt(a.tokens.input + a.tokens.cacheCreation) : "-",
                a ? fmtInt(a.tokens.cachedInput) : "-",
                a ? fmtInt(a.tokens.output) : "-",
                a ? fmtCost(a.costUsd) : "-",
                result,
            ];
        });
        lines.push(table(taskHeader, taskRows), "");
    }
    return lines.join("\n");
}
//# sourceMappingURL=report.js.map