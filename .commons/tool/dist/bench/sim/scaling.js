// How landing scales with the number of agents: a discrete-event model of two ways to integrate the same changes,
// calibrated with real ones. Each change is drawn from profiles recorded in a benchmark run (the packages it touched,
// the tests its changed code executes, how long its own related check took), so which changes interact, and how
// often, comes from a real repository rather than an assumption.
//
//   - merge queue (GitHub's, with the same checks): a pull request's own check, then a FIFO queue that builds up to
//     `queueBuilds` merge groups speculatively (entry i is checked with every entry ahead of it); a failing entry is
//     removed and every build behind it starts again; entries merge in order.
//   - commons: the change's own check (pre-verification), then it lands at once unless a change that landed since
//     its fork shares a test with it, in which case it is checked again on the current main first; changes that
//     share nothing never wait for each other. Landings are verified after, a package's newest landings together.
//
// A pair of changes that share a test breaks when combined with probability `conflictRate` (the merge-group check or
// Commons' check before landing catches it; the later change is fixed and resubmitted). Checks run on `slots`
// runners (Infinity for elastic CI). The model leaves out what both have (agents' own time, review) and what neither
// has here (flaky tests): it compares the integration disciplines on the same work.
//
//   node --import tsx src/bench/sim/scaling.ts --profiles bench/sim/workers-sdk-r24.json [--agents 4,8,16,32,64,128]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
/** Small deterministic RNG (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Whether two changes share a test (or one changed code the coverage maps cannot place in the other's package). */
export function interacts(a, b) {
    const pa = new Set(a.packages.filter((p) => p !== "(root)"));
    const pb = new Set(b.packages.filter((p) => p !== "(root)"));
    const wild = (w, other) => (w ?? []).some((d) => other.has(d.replace(/^packages\//, "")));
    if (a.tests === null || b.tests === null)
        return [...pa].some((p) => pb.has(p));
    if (wild(a.wildcard, pb) || wild(b.wildcard, pa))
        return true;
    const tb = new Set(b.tests);
    return a.tests.some((t) => tb.has(t));
}
/** A min-heap of timed events. */
class Events {
    heap = [];
    seq = 0;
    now = 0;
    at(t, fn) {
        this.heap.push({ at: t, seq: this.seq++, fn });
        let i = this.heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.before(this.heap[p], this.heap[i]))
                break;
            [this.heap[p], this.heap[i]] = [this.heap[i], this.heap[p]];
            i = p;
        }
    }
    before(x, y) {
        return x.at < y.at || (x.at === y.at && x.seq < y.seq);
    }
    run(until) {
        while (this.heap.length && !until()) {
            const top = this.heap[0];
            const last = this.heap.pop();
            if (this.heap.length) {
                this.heap[0] = last;
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1;
                    const r = l + 1;
                    let m = i;
                    if (l < this.heap.length && this.before(this.heap[l], this.heap[m]))
                        m = l;
                    if (r < this.heap.length && this.before(this.heap[r], this.heap[m]))
                        m = r;
                    if (m === i)
                        break;
                    [this.heap[m], this.heap[i]] = [this.heap[i], this.heap[m]];
                    i = m;
                }
            }
            this.now = top.at;
            top.fn();
        }
    }
}
/** Runners: a check starts when one is free. */
class Slots {
    ev;
    n;
    busy = 0;
    waiting = [];
    checkMs = 0;
    constructor(ev, n) {
        this.ev = ev;
        this.n = n;
    }
    check(durationMs, done) {
        let cancelled = false;
        let started = false;
        let startedAt = 0;
        const start = () => {
            if (cancelled)
                return this.release();
            started = true;
            startedAt = this.ev.now;
            this.ev.at(this.ev.now + durationMs, () => {
                if (cancelled)
                    return;
                this.checkMs += durationMs;
                this.release();
                done();
            });
        };
        if (this.busy < this.n) {
            this.busy++;
            start();
        }
        else
            this.waiting.push(() => start());
        return {
            cancel: () => {
                if (cancelled)
                    return;
                cancelled = true;
                // A cancelled running check still used its runner until now.
                if (started) {
                    this.checkMs += this.ev.now - startedAt;
                    this.release();
                }
            },
        };
    }
    release() {
        const next = this.waiting.shift();
        if (next)
            next();
        else
            this.busy--;
    }
}
function summarize(policy, agents, latencies, checkMs, endMs, wasted) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const min = (ms) => ms / 60_000;
    return {
        policy,
        agents,
        landed: sorted.length,
        latency: {
            median: min(sorted[Math.floor(sorted.length / 2)] ?? 0),
            p90: min(sorted[Math.floor(sorted.length * 0.9)] ?? 0),
            mean: min(sorted.reduce((s, x) => s + x, 0) / Math.max(1, sorted.length)),
            max: min(sorted.at(-1) ?? 0),
        },
        makespan: min(endMs),
        checkMinutesPerChange: min(checkMs) / Math.max(1, sorted.length),
        throughput: sorted.length / (endMs / 3_600_000),
        wastedChecks: wasted,
    };
}
/** Shared driver: agents take changes, think, submit; the policy lands them and calls back. */
function drive(o, policy, name) {
    const seed = o.seed ?? 1;
    const rand = rng(seed);
    const ev = new Events();
    const slots = new Slots(ev, o.slots ?? Infinity);
    const total = o.changes ?? Math.max(100, 12 * o.agents);
    const think = o.thinkMs ?? 6 * 60_000;
    const failRate = o.failRate ?? 0.1;
    const conflictRate = o.conflictRate ?? 0.1;
    const profiles = o.profiles.filter((p) => p.checkMs);
    const exp = (mean) => -Math.log(1 - rand()) * mean;
    // The work, drawn up front so every policy gets the same: change i's profile, how long its agent works on it, whether
    // it fails its own check, and how long a fix takes.
    const work = Array.from({ length: total }, () => ({ profile: profiles[Math.floor(rand() * profiles.length)], thinkMs: exp(think), ownFails: rand() < failRate, fixMs: exp(think / 3) }));
    // Whether two changes break together: fixed per pair (the code is what it is), the same under every policy.
    const conflicts = (a, b) => {
        if (!interacts(a.profile, b.profile))
            return false;
        const [x, y] = a.n < b.n ? [a.n, b.n] : [b.n, a.n];
        return rng(seed * 1_000_003 + x * 7919 + y)() < conflictRate;
    };
    let issued = 0;
    let landings = 0;
    const latencies = [];
    let wasted = 0;
    const h = {
        landed: (c) => {
            landings++;
            latencies.push(ev.now - c.submittedAt);
            startWork(c.agent);
        },
        bounced: (c) => {
            // The agent fixes it (its own failure or a conflict with what landed) and submits again from current main.
            ev.at(ev.now + work[c.n].fixMs, () => submit({ ...c, forkLanding: h.landingCount(), submittedAt: ev.now, ownFails: false }));
        },
        landingCount: () => landings,
        wasted: (k) => {
            wasted += k;
        },
        conflicts,
    };
    const submit = policy(ev, slots, h);
    const startWork = (agent) => {
        if (issued >= total)
            return;
        const n = issued++;
        const w = work[n];
        const forkLanding = landings;
        ev.at(ev.now + w.thinkMs, () => submit({ n, profile: w.profile, forkLanding, submittedAt: ev.now, ownFails: w.ownFails, agent }));
    };
    for (let a = 0; a < o.agents; a++)
        startWork(a);
    ev.run(() => landings >= total);
    return summarize(name, o.agents, latencies, slots.checkMs, ev.now, wasted);
}
/** GitHub's merge queue with the same checks: PR check, then speculative merge groups in FIFO order. */
export function simulateMergeQueue(o) {
    const builds = o.queueBuilds ?? 5;
    return drive(o, (ev, slots, h) => {
        const queue = [];
        const merged = [];
        const schedule = () => {
            for (let i = 0; i < Math.min(builds, queue.length); i++) {
                const e = queue[i];
                if (e.build || e.passed)
                    continue;
                const group = queue.slice(0, i + 1);
                // The merge group is main (everything merged since the fork) plus the entries ahead.
                e.breaks = [...merged.slice(e.c.forkLanding), ...group.slice(0, i).map((x) => x.c)].some((x) => h.conflicts(x, e.c));
                const ms = Math.max(...group.map((x) => x.c.profile.checkMs));
                e.build = slots.check(ms, () => {
                    e.build = undefined;
                    if (e.breaks) {
                        // Removed; every build behind it included it and starts again.
                        const at = queue.indexOf(e);
                        queue.splice(at, 1);
                        for (const x of queue.slice(at)) {
                            if (x.build) {
                                x.build.cancel();
                                x.build = undefined;
                                h.wasted(1);
                            }
                            if (x.passed) {
                                x.passed = false;
                                h.wasted(1);
                            }
                        }
                        h.bounced(e.c);
                    }
                    else
                        e.passed = true;
                    // Merge from the head while the head has passed.
                    while (queue[0]?.passed) {
                        const c = queue.shift().c;
                        merged.push(c);
                        h.landed(c);
                    }
                    schedule();
                });
            }
        };
        return (c) => {
            // The pull request's own check first.
            slots.check(c.profile.checkMs, () => {
                if (c.ownFails)
                    return h.bounced(c);
                queue.push({ c, passed: false, breaks: false });
                schedule();
            });
        };
    }, "merge-queue");
}
/** Commons: own check, then land at once unless an interacting change landed since the fork (then check on main). */
export function simulateCommons(o) {
    const integrators = o.integrators ?? 4;
    const batchMax = o.batchSize ?? 5;
    const fairAfter = o.fairAfter ?? 1;
    const stack = o.stack ?? false;
    const stackDepth = o.stackDepth ?? 5;
    return drive(o, (ev, slots, h) => {
        const landed = [];
        // Landings not yet verified after landing, per package lane; one check covers all of a lane's newest.
        const lanes = new Map();
        const verifyLane = (lane) => {
            const l = lanes.get(lane);
            if (l.running || !l.pending.length)
                return;
            const batch = l.pending.splice(0);
            l.running = true;
            slots.check(Math.max(...batch.map((c) => c.profile.checkMs)), () => {
                l.running = false;
                verifyLane(lane);
            });
        };
        const land = (c) => {
            landed.push(c);
            for (const p of c.profile.packages.filter((x) => x !== "(root)")) {
                if (!lanes.has(p))
                    lanes.set(p, { pending: [], running: false });
                lanes.get(p).pending.push(c);
                verifyLane(p);
            }
            h.landed(c);
        };
        // Changes an interacting landing reached since their fork wait for a check on main. Integrators take them in
        // batches (oldest first, none interacting with a batch already being checked, so parallel batches cannot
        // invalidate each other) and land each member its check cleared, as the executor does.
        const waiting = [];
        const running = [];
        let active = 0;
        const runs = [];
        const resolve = (run) => {
            const lower = run.below.flatMap((b) => b.batch);
            if (run.below.some((b) => !b.landedAll)) {
                // Checked on top of a change that did not land: the check says nothing about main.
                for (const w of [...run.picked].reverse())
                    waiting.unshift(w);
                h.wasted(1);
            }
            else {
                for (const w of run.picked) {
                    // Its fork had what landed before `checkedThrough`, earlier checks the rest up to there: only these are new.
                    const since = landed.slice(w.checkedThrough, run.through).filter((x) => interacts(x.profile, w.c.profile));
                    const peers = run.picked.filter((p) => p.c.n < w.c.n).map((p) => p.c);
                    if ([...since, ...peers, ...lower].some((x) => h.conflicts(x, w.c)))
                        h.bounced(w.c);
                    // Peers and the batches below were checked with it; anything else that landed during the check was not.
                    else if (landed.slice(run.through).some((x) => !run.batch.includes(x) && !lower.includes(x) && interacts(x.profile, w.c.profile)))
                        waiting.unshift({ c: w.c, checkedThrough: run.through, voided: w.voided + 1 });
                    else
                        land(w.c);
                }
            }
            run.landedAll = run.batch.every((c) => landed.includes(c));
            run.resolved = true;
            runs.splice(runs.indexOf(run), 1);
            running.splice(running.indexOf(run.picked), 1);
            for (const f of run.after.splice(0))
                f();
        };
        const pump = () => {
            while (active < integrators && waiting.length) {
                const picked = [];
                let below = [];
                for (const w of waiting) {
                    if (picked.length >= batchMax)
                        break;
                    const under = runs.filter((r) => r.batch.some((x) => interacts(x.profile, w.c.profile)));
                    if (under.length && !stack)
                        continue;
                    const chain = [...new Set([...below, ...under, ...under.flatMap((r) => r.below)])];
                    if (chain.length >= stackDepth)
                        continue;
                    below = chain;
                    picked.push(w);
                }
                if (!picked.length)
                    return;
                for (const w of picked)
                    waiting.splice(waiting.indexOf(w), 1);
                const run = { picked, batch: picked.map((w) => w.c), below, through: landed.length, checked: false, resolved: false, landedAll: false, after: [] };
                runs.push(run);
                running.push(picked);
                active++;
                // The check covers the batch and every batch below it: as long as the slowest of them.
                slots.check(Math.max(...[...run.batch, ...below.flatMap((b) => b.batch)].map((c) => c.profile.checkMs)), () => {
                    active--;
                    run.checked = true;
                    const open = run.below.filter((b) => !b.resolved);
                    if (!open.length)
                        resolve(run);
                    else {
                        let left = open.length;
                        for (const b of open)
                            b.after.push(() => {
                                if (--left === 0)
                                    resolve(run);
                            });
                    }
                    pump();
                });
            }
        };
        const tryLand = (c, checkedThrough) => {
            // Nothing that landed since the fork shares a test with it: it lands now, unless an older change it shares a
            // test with has had its check on main voided `fairAfter` times by landings like this one (aging: under
            // contention such a change could otherwise be voided forever).
            const starving = (w) => w.voided >= fairAfter && interacts(w.c.profile, c.profile);
            const ahead = waiting.some(starving) || running.flat().some(starving);
            if (!ahead && !landed.slice(checkedThrough).some((x) => interacts(x.profile, c.profile)))
                return land(c);
            waiting.push({ c, checkedThrough, voided: 0 });
            pump();
        };
        return (c) => {
            slots.check(c.profile.checkMs, () => {
                if (c.ownFails)
                    return h.bounced(c);
                tryLand(c, c.forkLanding);
            });
        };
    }, "commons");
}
export async function main(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            profiles: { type: "string" },
            agents: { type: "string", default: "4,8,16,32,64,128" },
            slots: { type: "string" },
            "think-min": { type: "string", default: "6" },
            "fail-rate": { type: "string", default: "0.1" },
            "conflict-rate": { type: "string", default: "0.1" },
            seeds: { type: "string", default: "5" },
        },
    });
    if (!values.profiles)
        throw new Error("usage: --profiles <profiles.json> [--agents 4,8,...] [--slots N] [--think-min M] [--fail-rate p] [--conflict-rate q] [--seeds K]");
    const profiles = JSON.parse(readFileSync(resolve(values.profiles), "utf8"));
    const base = {
        profiles,
        thinkMs: Number(values["think-min"]) * 60_000,
        failRate: Number(values["fail-rate"]),
        conflictRate: Number(values["conflict-rate"]),
        ...(values.slots ? { slots: Number(values.slots) } : {}),
    };
    const seeds = Number(values.seeds);
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    console.log(`| Agents | Policy | Latency median (min) | p90 | max | Check-min per change | All landed after (min) | Wasted checks |`);
    console.log(`|---|---|---|---|---|---|---|---|`);
    const variants = [
        { label: "merge queue", run: simulateMergeQueue },
        { label: "commons, no fairness", run: (x) => simulateCommons({ ...x, fairAfter: Infinity }) },
        { label: "commons, strict fairness", run: (x) => simulateCommons({ ...x, fairAfter: 0 }) },
        { label: "commons", run: simulateCommons },
        { label: "commons, stacked", run: (x) => simulateCommons({ ...x, stack: true }) },
    ];
    for (const n of values.agents.split(",").map(Number)) {
        for (const v of variants) {
            const runs = Array.from({ length: seeds }, (_, s) => v.run({ ...base, agents: n, seed: s + 1 }));
            const f = (g, d = 1) => mean(runs.map(g)).toFixed(d);
            console.log(`| ${n} | ${v.label} | ${f((r) => r.latency.median)} | ${f((r) => r.latency.p90)} | ${f((r) => r.latency.max)} | ${f((r) => r.checkMinutesPerChange)} | ${f((r) => r.makespan, 0)} | ${f((r) => r.wastedChecks, 0)} |`);
        }
    }
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=scaling.js.map