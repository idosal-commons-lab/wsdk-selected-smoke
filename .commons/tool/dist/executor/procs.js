// What a command leaves running when it ends. Killing its process group is not enough: test suites start long-lived
// processes in groups or sessions of their own (workers-sdk's vitest-plugin tests run `vitest dev` watchers that way;
// thirty were still running 3.5 hours after the arm that started them was stopped), and once their parents exit they
// are children of init, out of reach of a walk down the process tree. So every command is also marked: a variable in
// its environment, which everything it starts inherits whatever group, session or directory it moves to. When the
// command ends, its group, the processes descending from it and every process carrying the mark are stopped (so none
// can start another while they are collected) and then killed.
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
const PS_TABLE = ["-Ao", "pid=,ppid=,pgid=,uid=,etime="];
/** macOS `ps -E` appends the environment a process started with to its command line (Linux reads /proc instead). */
const PS_ENV = ["-wwE", "-o", "pid=,command=", "-p"];
const MAX_BUFFER = 64 * 1024 * 1024;
/** Stop-and-rescan rounds before the kill; a round finding nothing new ends it (one listing when nothing was left). */
const MAX_ROUNDS = 5;
/** A fresh environment variable name for `{ [mark]: "1" }`. */
export function newMark() {
    return `COMMONS_RUN_${randomBytes(6).toString("hex")}`;
}
/** ps `etime` (`[[dd-]hh:]mm:ss`) in seconds. */
export function etimeSeconds(etime) {
    const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
    const parts = clock.split(":").map(Number);
    while (parts.length < 3)
        parts.unshift(0);
    return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}
export function parseProcTable(listing) {
    const out = [];
    for (const line of listing.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
        if (m)
            out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), ageS: etimeSeconds(m[5]) });
    }
    return out;
}
/** Every process below `roots` in `table` (not the roots themselves). */
export function descendantsOf(table, roots) {
    const children = new Map();
    for (const p of table) {
        const list = children.get(p.ppid);
        if (list)
            list.push(p.pid);
        else
            children.set(p.ppid, [p.pid]);
    }
    const out = new Set();
    const stack = [...roots];
    while (stack.length > 0) {
        for (const child of children.get(stack.pop()) ?? []) {
            if (out.has(child))
                continue;
            out.add(child);
            stack.push(child);
        }
    }
    return out;
}
/** This user's processes, never this one, its parent or init. */
function ownProcs(table) {
    const uid = process.getuid?.();
    return table.filter((p) => p.pid > 1 && p.pid !== process.pid && p.pid !== process.ppid && (uid === undefined || p.uid === uid));
}
/**
 * The processes worth reading the environment of: those started since the run whose parent is older. A marked process
 * inherited the mark from its parent, or was adopted by init when that exited, so it is one of these or below one.
 */
function candidatesOf(own, run, found) {
    const maxAge = (Date.now() - run.startedAt) / 1000 + 1;
    const young = new Set(own.filter((p) => p.ageS <= maxAge).map((p) => p.pid));
    return own.filter((p) => young.has(p.pid) && !young.has(p.ppid) && !found.has(p.pid)).map((p) => p.pid);
}
/** The run's processes not collected yet: its group, the marked ones, and everything below those and the collected. */
function freshOf(own, run, found, marked) {
    const roots = new Set([...found, ...marked]);
    if (run.pgid !== undefined)
        for (const p of own)
            if (p.pgid === run.pgid)
                roots.add(p.pid);
    const owned = new Set(own.map((p) => p.pid));
    for (const pid of descendantsOf(own, roots))
        roots.add(pid);
    return [...roots].filter((pid) => !found.has(pid) && owned.has(pid));
}
function envMarked(pids, mark, listing) {
    if (listing === null) {
        return pids.filter((pid) => {
            try {
                return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`${mark}=1`);
            }
            catch {
                return false;
            }
        });
    }
    const out = [];
    for (const line of listing.split("\n")) {
        const m = /^\s*(\d+)\s/.exec(line);
        if (m && line.includes(` ${mark}=1`))
            out.push(Number(m[1]));
    }
    return out;
}
function signal(pid, sig) {
    try {
        process.kill(pid, sig);
    }
    catch {
        // already gone, or not ours
    }
}
function killAll(run, found) {
    if (run.pgid !== undefined)
        signal(-run.pgid, "SIGKILL");
    for (const pid of found)
        signal(pid, "SIGKILL");
}
function psAsync(args) {
    return new Promise((resolve) => {
        // ps exits 1 when a listed pid is gone; what it printed is still usable.
        execFile("ps", args, { encoding: "utf8", maxBuffer: MAX_BUFFER }, (_error, stdout) => resolve(stdout ?? ""));
    });
}
function psSync(args) {
    try {
        return execFileSync("ps", args, { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] });
    }
    catch (error) {
        return String(error.stdout ?? "");
    }
}
/** The sweep itself, yielding the ps arguments it needs run, so the same rounds drive `reapRun` and `reapRunSync`. */
function* sweep(run) {
    const found = new Set();
    try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
            const own = ownProcs(parseProcTable(yield PS_TABLE));
            const candidates = candidatesOf(own, run, found);
            const listing = process.platform === "linux" || candidates.length === 0 ? null : yield [...PS_ENV, candidates.join(",")];
            const fresh = freshOf(own, run, found, candidates.length === 0 ? [] : envMarked(candidates, run.mark, listing));
            if (fresh.length === 0)
                break;
            for (const pid of fresh) {
                found.add(pid);
                signal(pid, "SIGSTOP");
            }
        }
    }
    finally {
        // Whatever happened, nothing stays stopped and the group goes too.
        killAll(run, found);
    }
    return [...found];
}
/**
 * Stop and kill what `run` left: its process group, every process carrying its mark, and everything below those.
 * Without ps only the group is killed. Returns the pids killed (the group's are not listed when ps is unavailable).
 */
export async function reapRun(run) {
    const rounds = sweep(run);
    let step = rounds.next();
    while (!step.done)
        step = rounds.next(await psAsync(step.value));
    return step.value;
}
/** `reapRun` without yielding to the event loop, for teardown in a signal handler (nothing else may start meanwhile). */
export function reapRunSync(run) {
    const rounds = sweep(run);
    let step = rounds.next();
    while (!step.done)
        step = rounds.next(psSync(step.value));
    return step.value;
}
//# sourceMappingURL=procs.js.map