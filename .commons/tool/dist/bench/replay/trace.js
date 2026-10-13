// A replay trace: what real agents submitted in one benchmark run (each task's submissions as patches against the main
// they were made on, and how long the agent took before each), so the same work can be replayed through another
// integration system, at another concurrency or time scale, without models. The agents' variance drops out and what
// is left is the integration: how long a submission waits to land, what verifying it costs, whether main stays green.
//
//   node --import tsx src/bench/replay/trace.ts --run ~/.commons-bench/bench/issues-workers-sdk-r24/commons --out <dir>
//
// The fake agent replays a task with `FAKE: replay <dir>/trace.json` in its body (src/runner/fake-agent.ts).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
/** Read a recorded commons/queue run (its coordinator database and host) into a trace in `out`. */
export function extractTrace(runDir, out) {
    const run = resolve(runDir);
    const db = new DatabaseSync(join(run, "coordinator.sqlite"), { readOnly: true });
    const host = join(run, "host.git");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, "patches"), { recursive: true });
    // The patches' blobs live in the recorded host; keep a copy beside the trace so it outlives the run's directory.
    cpSync(join(host, "objects"), join(out, "objects"), { recursive: true });
    const base = execFileSync("git", ["-C", host, "rev-list", "--max-parents=0", "refs/heads/main"], { encoding: "utf8" }).trim().split("\n").pop();
    const started = new Map(db.prepare("select task_id, min(at) as at from events where type = 'task.started' group by task_id").all().map((r) => [String(r.task_id), Number(r.at)]));
    const abandoned = new Map(db.prepare("select task_id, max(at) as at from events where type = 'task.abandoned' group by task_id").all().map((r) => [String(r.task_id), Number(r.at)]));
    const tasks = {};
    for (const { id } of db.prepare("select id from tasks order by ord").all()) {
        const taskId = String(id);
        const subs = db.prepare("select id, commit_sha, parent_main, status, created_at, updated_at from submissions where task_id = ? order by created_at").all(taskId);
        const start = started.get(taskId) ?? Number(subs[0]?.created_at ?? 0);
        const attempts = [];
        let since = start;
        for (const s of subs) {
            const patch = join("patches", `${taskId}.${attempts.length}.patch`);
            // Against the merge base with the main the agent submitted on: the agent's own change (a main recorded after the
            // agent forked would otherwise read as reverting what landed in between), with full blob ids so it applies
            // three-way when the replay's main has moved under it.
            const diff = execFileSync("git", ["-C", host, "diff", "--binary", "--full-index", `${String(s.parent_main)}...${String(s.commit_sha)}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
            writeFileSync(join(out, patch), diff);
            attempts.push({ patch, thinkMs: Math.max(0, Number(s.created_at) - since), outcome: String(s.status) });
            since = Number(s.updated_at);
        }
        const gaveUp = abandoned.get(taskId);
        tasks[taskId] = { id: taskId, attempts, ...(gaveUp !== undefined ? { giveUpMs: Math.max(0, gaveUp - since) } : {}) };
    }
    db.close();
    const trace = { source: run, base, objects: join(resolve(out), "objects"), tasks };
    writeFileSync(join(out, "trace.json"), JSON.stringify(trace, null, 2) + "\n");
    return trace;
}
export async function main(argv) {
    const { values } = parseArgs({ args: argv, options: { run: { type: "string" }, out: { type: "string" } } });
    if (!values.run || !values.out)
        throw new Error("usage: --run <recorded arm dir with coordinator.sqlite and host.git> --out <trace dir>");
    if (!existsSync(join(values.run, "coordinator.sqlite")))
        throw new Error(`${values.run} has no coordinator.sqlite`);
    const trace = extractTrace(values.run, resolve(values.out));
    const all = Object.values(trace.tasks);
    const submitted = all.filter((t) => t.attempts.length);
    console.log(`${all.length} tasks, ${submitted.length} submitted, ${submitted.reduce((n, t) => n + t.attempts.length, 0)} submissions, base ${trace.base.slice(0, 12)} -> ${values.out}`);
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=trace.js.map