// Aggregate several benchmark run directories (each with <arm>/report.json) into one Markdown table with means.
// Usage: node --import tsx src/bench/aggregate.ts <runDir>... [--out file.md]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
function rowOf(run, r) {
    const official = r.official ? Object.values(r.official) : null;
    const sum = (f) => r.agents.reduce((acc, a) => acc + f(a), 0);
    const costs = r.agents.map((a) => a.costUsd).filter((c) => typeof c === "number");
    const cost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
    return {
        run,
        arm: r.arm,
        wallS: r.wallMs / 1000,
        landed: r.tasks.filter((t) => t.landed).length,
        total: r.tasks.length,
        official: official ? official.filter(Boolean).length : null,
        officialTotal: official ? official.length : null,
        suite: r.finalSuitePassed ?? null,
        uncached: sum((a) => a.tokens.input + (a.tokens.cacheCreation ?? 0)),
        cached: sum((a) => a.tokens.cachedInput),
        output: sum((a) => a.tokens.output),
        cost,
        // Preserve unknown costs in historical reports, before systemCostUsd was recorded.
        systemCost: r.systemCostUsd ?? (cost !== null || r.executorCostUsd ? (cost ?? 0) + (r.executorCostUsd ?? 0) : null),
        turns: sum((a) => a.turns ?? 0),
        bounces: r.metrics ? r.metrics.bounces : null,
        conflicts: r.metrics ? r.metrics.conflicts : null,
    };
}
const fmt = (n, d = 0) => (n === null ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const mean = (xs) => {
    const v = xs.filter((x) => typeof x === "number");
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
export function aggregate(runDirs) {
    const rows = [];
    for (const dir of runDirs) {
        for (const arm of ["commons", "queue", "github", "baseline"]) {
            const p = join(dir, arm, "report.json");
            if (!existsSync(p))
                continue;
            rows.push(rowOf(basename(dir), JSON.parse(readFileSync(p, "utf8"))));
        }
    }
    const lines = [
        "| Run | Arm | Wall (s) | Landed | Official | Suite | Uncached input | Cached input | Output | Cost (agents) | Cost (system) | Turns | Bounces | Conflicts |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const r of rows) {
        lines.push(`| ${r.run} | ${r.arm} | ${fmt(r.wallS, 1)} | ${r.landed}/${r.total} | ${r.official === null ? "-" : `${r.official}/${r.officialTotal}`} | ${r.suite === null ? "-" : r.suite ? "pass" : "FAIL"} | ${fmt(r.uncached)} | ${fmt(r.cached)} | ${fmt(r.output)} | ${r.cost === null ? "-" : "$" + fmt(r.cost, 2)} | ${r.systemCost === null ? "-" : "$" + fmt(r.systemCost, 2)} | ${r.turns} | ${r.bounces === null ? "-" : r.bounces} | ${r.conflicts === null ? "-" : r.conflicts} |`);
    }
    const arms = ["commons", "queue", "github", "baseline"].map((arm) => ({ arm, rows: rows.filter((r) => r.arm === arm) })).filter((a) => a.rows.length > 0);
    lines.push("", "| Arm (mean of n) | n | Wall (s) | Landed | Official | Suite pass | Uncached input | Cost (agents) | Cost (system) | Turns |", "|---|---|---|---|---|---|---|---|---|---|");
    const means = {};
    for (const { arm, rows: rs } of arms) {
        const m = { wall: mean(rs.map((r) => r.wallS)), uncached: mean(rs.map((r) => r.uncached)), cost: mean(rs.map((r) => r.cost)), systemCost: mean(rs.map((r) => r.systemCost)), official: mean(rs.map((r) => r.official)) };
        means[arm] = m;
        lines.push(`| ${arm} | ${rs.length} | ${fmt(m.wall, 1)} | ${fmt(mean(rs.map((r) => r.landed)), 2)}/${rs[0].total} | ${m.official === null ? "-" : `${fmt(m.official, 2)}/${rs[0].officialTotal}`} | ${rs.filter((r) => r.suite).length}/${rs.length} | ${fmt(m.uncached)} | ${m.cost === null ? "-" : "$" + fmt(m.cost, 2)} | ${m.systemCost === null ? "-" : "$" + fmt(m.systemCost, 2)} | ${fmt(mean(rs.map((r) => r.turns)), 1)} |`);
    }
    const c = means.commons;
    const b = means.baseline;
    if (c && b) {
        const ratio = (x, y) => (x === null || y === null || y === 0 ? "-" : (x / y).toFixed(2));
        lines.push("", `Ratios commons/baseline (means): wall ${ratio(c.wall, b.wall)}, uncached input ${ratio(c.uncached, b.uncached)}, cost ${ratio(c.cost, b.cost)}, system cost ${ratio(c.systemCost, b.systemCost)}, official passes ${ratio(c.official, b.official)}.`);
    }
    return lines.join("\n") + "\n";
}
const isMain = process.argv[1] && /aggregate\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
    const args = process.argv.slice(2);
    const outIdx = args.indexOf("--out");
    const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
    const dirs = args.filter((a, i) => a !== "--out" && (outIdx < 0 || i !== outIdx + 1));
    const md = aggregate(dirs);
    if (out)
        writeFileSync(out, md);
    process.stdout.write(md);
}
//# sourceMappingURL=aggregate.js.map