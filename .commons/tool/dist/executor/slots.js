// A machine-wide limit on concurrent heavy checks. Every integrator, every agent's pre-verification and the queue run
// the same test suites on one machine; on workers-sdk eight agents, four integrators and a pre-verification per
// submission put 25 vitest processes, each sized for the whole machine, on ten cores (load average 438), and checks
// that take seven minutes alone timed out at thirty. Slots are lock files in a shared directory (one per running
// check, holding the holder's pid), so separate processes (integrators in the runner, detached pre-verification
// runners) share the limit without a server. A slot whose holder died is reclaimed.
//
// Free slots go to waiters by priority, then by how long they have waited: checks of changes on their way to main or
// already on it before agents' pre-verifications, which in the sixteenth run took 72 of 115 check-minutes and were
// served first come first served alongside them. A waiter is a file too, so the order holds across processes, and
// waiting ages a waiter up one priority level every two minutes, so a busy queue delays pre-verification but never
// starves it.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Checks that gate a landing or verify one that landed. */
export const PRIORITY_INTEGRATION = 0;
/** An agent's check of its own submission, before any integrator needs it. */
export const PRIORITY_PREVERIFY = 1;
const AGING_MS = 120_000;
let waiterSeq = 0;
/** `COMMONS_CHECK_SLOTS=<count>:<dir>`; null when unset or malformed. */
export function checkSlotsFromEnv(env = process.env) {
    const raw = env.COMMONS_CHECK_SLOTS;
    if (!raw)
        return null;
    const m = /^(\d+):(.+)$/.exec(raw);
    if (!m || Number(m[1]) < 1)
        return null;
    return { count: Number(m[1]), dir: m[2] };
}
export function checkSlotsEnv(slots) {
    return `${slots.count}:${slots.dir}`;
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function effective(w, now) {
    return w.priority - Math.floor((now - w.since) / AGING_MS);
}
/** Whether a live waiter other than `me` comes first: a better effective priority, or the same and waiting longer. */
function someoneAhead(slots, me) {
    let names;
    try {
        names = readdirSync(slots.dir);
    }
    catch {
        return false;
    }
    const now = Date.now();
    const mine = effective(me, now);
    for (const name of names) {
        const m = /^wait-(\d+)-(\d+)-(\d+)-\d+$/.exec(name);
        if (!m || name === me.name)
            continue;
        const other = { priority: Number(m[1]), since: Number(m[2]) };
        if (!alive(Number(m[3]))) {
            try {
                unlinkSync(join(slots.dir, name));
            }
            catch {
                // already gone
            }
            continue;
        }
        const theirs = effective(other, now);
        if (theirs < mine || (theirs === mine && other.since < me.since))
            return true;
    }
    return false;
}
/**
 * Take a free slot (reclaiming one whose holder died), or null when all are held. With `me`, also null while a waiter
 * that comes before it is waiting (see someoneAhead).
 */
export function tryAcquireSlot(slots, me) {
    mkdirSync(slots.dir, { recursive: true });
    if (me && someoneAhead(slots, me))
        return null;
    for (let i = 0; i < slots.count; i++) {
        const path = join(slots.dir, `slot-${i}`);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                writeFileSync(path, String(process.pid), { flag: "wx" });
                let released = false;
                return () => {
                    if (released)
                        return;
                    released = true;
                    try {
                        unlinkSync(path);
                    }
                    catch {
                        // already reclaimed
                    }
                };
            }
            catch {
                let holder = 0;
                try {
                    holder = Number(readFileSync(path, "utf8"));
                }
                catch {
                    continue; // released between the two calls: try again
                }
                if (holder > 0 && !alive(holder)) {
                    try {
                        unlinkSync(path);
                    }
                    catch {
                        // someone else reclaimed it
                    }
                    continue;
                }
                break; // held by a live process: next slot
            }
        }
    }
    return null;
}
/**
 * Run `fn` holding a slot; waits (polling) until one is free and no waiter comes before it. With no slots configured,
 * runs at once.
 */
export async function withCheckSlot(slots, fn, opts = {}) {
    if (!slots)
        return fn();
    // A priority function is asked again at every poll: a waiter can be promoted while it waits.
    const priorityNow = () => Math.max(0, Math.floor((typeof opts.priority === "function" ? opts.priority() : opts.priority) ?? PRIORITY_INTEGRATION));
    const since = Date.now();
    const seq = waiterSeq++;
    const waiter = (priority) => ({ priority, since, name: `wait-${priority}-${since}-${process.pid}-${seq}` });
    let me = waiter(priorityNow());
    let release = tryAcquireSlot(slots, me);
    if (!release) {
        opts.onWait?.();
        writeFileSync(join(slots.dir, me.name), "");
        try {
            while (!release) {
                await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 1000));
                const now = waiter(priorityNow());
                if (now.name !== me.name) {
                    writeFileSync(join(slots.dir, now.name), "");
                    try {
                        unlinkSync(join(slots.dir, me.name));
                    }
                    catch {
                        // already gone
                    }
                    me = now;
                }
                release = tryAcquireSlot(slots, me);
            }
        }
        finally {
            try {
                unlinkSync(join(slots.dir, me.name));
            }
            catch {
                // already gone
            }
        }
    }
    try {
        return await fn();
    }
    finally {
        release();
    }
}
//# sourceMappingURL=slots.js.map