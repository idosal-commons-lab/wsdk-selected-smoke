// Agents leave processes behind: esbuild services, vitest workers and dev servers started inside a worktree can
// outlive the agent that started them (they detach, or their parent was killed at the time budget). Two such
// esbuild services ran for more than a day at over a core between them, under every later run. When an arm ends,
// every process whose command line names a path under the arm's directory is killed, and every process carrying the
// arm's mark in its environment (procs.ts), wherever its working directory or arguments point.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { newMark, reapRunSync } from "../executor/procs.js";
/** `dir` and, when it differs, its real path: lsof reports /tmp/cb-x as /private/tmp/cb-x on macOS. */
function spellings(dir) {
    try {
        const real = realpathSync(dir);
        return real === dir ? [dir] : [dir, real];
    }
    catch {
        return [dir];
    }
}
/** Pids whose working directory is `dir` or under it (one `lsof` call; empty when lsof is unavailable). */
export function pidsWithCwdUnder(dir) {
    let listing = "";
    try {
        listing = execFileSync("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    }
    catch (error) {
        // lsof exits 1 when some processes could not be inspected; its output is still usable.
        listing = String(error.stdout ?? "");
    }
    const dirs = spellings(dir).map((d) => d.replace(/\/+$/, ""));
    const out = [];
    let pid = 0;
    for (const line of listing.split("\n")) {
        if (line.startsWith("p"))
            pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid > 0) {
            const cwd = line.slice(1);
            if (dirs.some((d) => cwd === d || cwd.startsWith(`${d}/`)))
                out.push(pid);
        }
    }
    return out;
}
/**
 * Kill every process (other than this one and its parent) whose command line names a path under `dir`, or whose
 * working directory is under it; returns their pids. The working directory catches what the command line cannot:
 * agents' shell loops (`until ...; do sleep 5; done`) left running in their launch directory for a day.
 */
export function reapStrays(dir, log) {
    if (!dir || dir === "/")
        return [];
    let listing = "";
    try {
        // -ww: otherwise ps may cut command lines to the width of a terminal it finds on another descriptor.
        listing = execFileSync("ps", ["-axwwo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    }
    catch {
        return [];
    }
    const dirs = spellings(dir);
    const targets = new Set(pidsWithCwdUnder(dir));
    for (const line of listing.split("\n")) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (m && dirs.some((d) => m[2].includes(d)))
            targets.add(Number(m[1]));
    }
    targets.delete(process.pid);
    targets.delete(process.ppid);
    const killed = [];
    for (const pid of targets) {
        try {
            process.kill(pid, "SIGKILL");
            killed.push(pid);
        }
        catch {
            // already gone, or not ours
        }
    }
    if (killed.length > 0)
        log?.(`reaped ${killed.length} stray process(es) left under ${dir}`);
    return killed;
}
/** Kill every process started since `startedAt` whose environment carries `mark`, and everything below them. */
export function reapMarked(mark, startedAt, log) {
    const killed = reapRunSync({ mark, startedAt });
    if (killed.length > 0)
        log?.(`reaped ${killed.length} process(es) started under this run and left running`);
    return killed;
}
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
/**
 * Mark everything this process starts from now on, and kill all of it, then run `teardown`, when `close` is called or
 * a stop signal arrives; the signal then takes its course. A stopped runner exits without running `finally`, and
 * what it started in process groups of their own (checks, agents) never sees an interrupt at the terminal.
 */
export function reapScope(o = {}) {
    const mark = newMark();
    const startedAt = Date.now();
    process.env[mark] = "1";
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        for (const sig of STOP_SIGNALS)
            process.off(sig, onSignal);
        reapMarked(mark, startedAt, o.log);
        delete process.env[mark];
        o.teardown?.();
    };
    const onSignal = (sig) => {
        o.log?.(`${sig}: killing what this run started`);
        close();
        process.kill(process.pid, sig);
    };
    for (const sig of STOP_SIGNALS)
        process.on(sig, onSignal);
    return { mark, close };
}
//# sourceMappingURL=reap.js.map