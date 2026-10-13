// Recompute phase accounting from a run's saved agent streams and rewrite its reports, so a better classifier never
// requires re-running a benchmark.
//   node --import tsx src/bench/rescore.ts <dir> [<dir>...]
// A directory is an arm (report.json + logs/<task>.stream.jsonl) or a bench root holding commons/queue/baseline arms.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentStreamParser } from "../runner/agents.js";
import { renderReport } from "../runner/report.js";
/** Phases and submit wait recomputed from an NDJSON stream, using the events' own timestamps for latencies. */
export function rescoreStream(text) {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const stamps = lines.map((l) => {
        try {
            const t = Date.parse(JSON.parse(l).timestamp ?? "");
            return Number.isFinite(t) ? t : null;
        }
        catch {
            return null;
        }
    });
    let last = stamps.find((t) => t !== null) ?? 0;
    const parser = new AgentStreamParser("claude", last);
    lines.forEach((line, i) => {
        const t = stamps[i];
        if (t !== null && t !== undefined)
            last = t;
        parser.receive(line, last);
    });
    return { phases: parser.phases, submitWaitMs: parser.submitWaitMs };
}
export function rescoreArm(dir, log = () => { }) {
    const reportPath = join(dir, "report.json");
    if (!existsSync(reportPath))
        return null;
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    let changed = 0;
    for (const a of report.agents) {
        const f = join(dir, "logs", `${a.taskId}.stream.jsonl`);
        if (!existsSync(f) || a.kind !== "claude")
            continue;
        const r = rescoreStream(readFileSync(f, "utf8"));
        a.phases = r.phases;
        a.submitWaitMs = r.submitWaitMs;
        changed++;
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(dir, "report.md"), renderReport([report]));
    log(`${dir}: rescored ${changed}/${report.agents.length} agents`);
    return report;
}
export function rescoreRun(dir, log = () => { }) {
    const own = rescoreArm(dir, log);
    if (own)
        return [own];
    const reports = [];
    for (const arm of ["commons", "queue", "baseline"]) {
        const r = rescoreArm(join(dir, arm), log);
        if (r)
            reports.push(r);
    }
    if (reports.length > 0) {
        writeFileSync(join(dir, "summary.md"), renderReport(reports));
        writeFileSync(join(dir, "summary.json"), JSON.stringify(reports.map((r) => ({ ...r, events: r.events.length })), null, 2) + "\n");
    }
    return reports;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    const dirs = process.argv.slice(2);
    if (dirs.length === 0) {
        console.error("usage: rescore.ts <run dir> [<run dir>...]");
        process.exit(2);
    }
    for (const d of dirs) {
        const n = rescoreRun(resolve(d), (l) => console.error(`[rescore] ${l}`)).length;
        if (n === 0)
            console.error(`[rescore] ${d}: no report.json found`);
    }
}
//# sourceMappingURL=rescore.js.map