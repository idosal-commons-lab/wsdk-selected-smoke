// Checks run against a candidate commit, plus a content-addressed verdict cache.
//
// `Check` is deliberately small so other runtimes can implement it: a DockerCheck
// would call `checkoutDetached`, then `runCommand(["docker", "run", ...])` with the
// work clone bind-mounted, and reuse `parseFailedTests`/`excerptOf` for the verdict.
import { spawn } from "node:child_process";
import { git } from "./git.js";
import { newMark, reapRun } from "./procs.js";
import { checkSlotsFromEnv, PRIORITY_INTEGRATION, withCheckSlot } from "./slots.js";
/**
 * A result that says nothing about the code: a timeout. In the twenty-second run a check that timed out on a loaded
 * machine was stored, reused as a known failure, and bounced its submission three more times without running again.
 */
export function inconclusive(r) {
    return !!r && !r.passed && (r.timedOut === true || r.excerpt.startsWith("timeout: "));
}
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const EXCERPT_LINES = 40;
/** Combined output kept in memory per command run; older output is dropped. */
const OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const FAIL_LINE = /^\s*(?:✕|✗|×|FAIL|not ok)\s+(.+?)\s*$/;
const JEST_BULLET = /^\s*●\s+(.+?)\s*$/;
const TRAILING_DURATION = /\s*(?:\(\s*\d+(?:\.\d+)?\s*m?s\s*\)|\d+(?:\.\d+)?\s*m?s)$/;
/** vitest marks a test that failed after retries: `name 10048ms (retry x1)`. */
const TRAILING_RETRY = /\s*\(retry x\d+\)$/;
const TAP_PREFIX = /^\d+\s*(?:-\s*)?/;
export function stripAnsi(s) {
    return s.replace(ANSI, "");
}
/** POSIX single-quote shell quoting. */
export function shellQuote(s) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
/** The shell command for a check: the related template when there are changed files, else the full command. */
export function renderCommand(command, relatedTemplate, changedFiles) {
    if (relatedTemplate && changedFiles.length > 0) {
        return relatedTemplate.split("{files}").join(changedFiles.map(shellQuote).join(" "));
    }
    return command;
}
/**
 * Default failed-test parser. Recognizes lines beginning with ✕ ✗ × FAIL or `not ok`
 * (jest, vitest, mocha, TAP) and jest's `● Suite › name` failure headers.
 */
const MAX_FAILED_TESTS = 40;
/** jest multi-project output prefixes suite paths with the project name: `FAIL Web src/x.test.tsx`. */
const PROJECT_PREFIX = /^[A-Z][\w-]*\s+(?=\S*[\\/])/;
const RELATIVE_PREFIX = /^(?:\.\.\/)+/;
/** vitest labels a test of a named project: `|unit| packages/b/__tests__/x.spec.ts > case`. */
const VITEST_PROJECT = /^\|[^|]+\|\s+/;
export function parseFailedTests(stdout, stderr) {
    const seen = new Set();
    const out = [];
    const push = (name) => {
        const trimmed = name.trim().replace(VITEST_PROJECT, "").replace(PROJECT_PREFIX, "").replace(RELATIVE_PREFIX, "");
        if (!trimmed || seen.has(trimmed) || out.length >= MAX_FAILED_TESTS)
            return;
        seen.add(trimmed);
        out.push(trimmed);
    };
    for (const line of stripAnsi(`${stdout}\n${stderr}`).split(/\r?\n/)) {
        const fail = FAIL_LINE.exec(line);
        if (fail) {
            let name = fail[1].replace(TRAILING_RETRY, "").replace(TRAILING_DURATION, "");
            if (/^\s*not ok/.test(line))
                name = name.replace(TAP_PREFIX, "");
            push(name);
            continue;
        }
        const bullet = JEST_BULLET.exec(line);
        if (bullet && bullet[1] !== "Console")
            push(bullet[1]);
    }
    return out;
}
/** The last `lines` lines of `output`, ANSI codes removed. */
export function excerptOf(output, lines = EXCERPT_LINES) {
    const all = stripAnsi(output).replace(/\s+$/, "").split(/\r?\n/);
    return all.slice(-lines).join("\n");
}
/** Check out `commit` detached in the executor's own work clone (local edits are discarded). */
export async function checkoutDetached(work, commit) {
    await git(work, ["checkout", "--quiet", "--force", "--detach", commit]);
}
/**
 * How much a check yields the CPU (nice level, COMMONS_CHECK_NICE, default 5; 0 turns it off). Checks share the
 * machine with the agents, and an agent's tool calls are always on the critical path while a check, with optimistic
 * landing, mostly is not: on vuejs/core an agent's turn took 17.7 s beside Commons' checks against 9.7 s in the
 * baseline arm, which runs none.
 */
export function checkNice(env = process.env) {
    const n = Number(env.COMMONS_CHECK_NICE ?? 5);
    return Number.isInteger(n) && n > 0 && n <= 19 && process.platform !== "win32" ? n : 0;
}
/** `argv` run at the checks' nice level. */
export function niced(argv) {
    const n = checkNice();
    return n > 0 ? ["nice", "-n", String(n), ...argv] : argv;
}
/**
 * Spawn `argv` in its own process group and capture output. Nothing it starts outlives it: when it ends or times out,
 * its group and every process it started, wherever that moved (procs.ts), are killed.
 */
export function runCommand(argv, opts) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const mark = newMark();
        const child = spawn(argv[0], argv.slice(1), {
            cwd: opts.cwd,
            env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1", ...opts.env, [mark]: "1" },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
        });
        const chunks = [];
        let size = 0;
        const collect = (stream) => (data) => {
            const text = data.toString();
            chunks.push({ stream, text });
            size += text.length;
            while (size > OUTPUT_CAP_BYTES && chunks.length > 1)
                size -= chunks.shift().text.length;
        };
        child.stdout?.on("data", collect("stdout"));
        child.stderr?.on("data", collect("stderr"));
        let timedOut = false;
        let settled = false;
        // One sweep per run: on a timeout it starts while the tree is still intact, and the run settles once it is done.
        let reaping = null;
        const reap = () => {
            if (!child.pid)
                return Promise.resolve();
            reaping ??= reapRun({ pgid: child.pid, mark, startedAt: started }).catch(() => undefined);
            return reaping;
        };
        const timer = setTimeout(() => {
            timedOut = true;
            void reap();
        }, timeoutMs);
        const finish = async (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            await reap();
            resolve({
                code,
                signal,
                stdout: chunks.filter((c) => c.stream === "stdout").map((c) => c.text).join(""),
                stderr: chunks.filter((c) => c.stream === "stderr").map((c) => c.text).join(""),
                output: chunks.map((c) => c.text).join(""),
                timedOut,
                durationMs: Date.now() - started,
            });
        };
        child.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        // Prefer "close" (all output flushed); fall back shortly after "exit" if a stray grandchild keeps the pipes open.
        child.on("close", (code, signal) => void finish(code, signal));
        child.on("exit", (code, signal) => {
            setTimeout(() => void finish(code, signal), 2000).unref();
        });
    });
}
export class CommandCheck {
    id;
    command;
    relatedTemplate;
    timeoutMs;
    parse;
    env;
    slots;
    priority;
    constructor(id, command, opts = {}) {
        this.id = id;
        this.command = command;
        this.relatedTemplate = opts.relatedTemplate;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
        this.parse = opts.parse ?? parseFailedTests;
        this.env = opts.env;
        this.slots = opts.slots;
        this.priority = opts.priority ?? PRIORITY_INTEGRATION;
    }
    /** The same check (same id, so verdicts are shared) with more environment variables. */
    withEnv(env) {
        return new CommandCheck(this.id, this.command, {
            ...(this.relatedTemplate !== undefined ? { relatedTemplate: this.relatedTemplate } : {}),
            timeoutMs: this.timeoutMs,
            parse: this.parse,
            env: { ...this.env, ...env },
            ...(this.slots !== undefined ? { slots: this.slots } : {}),
            priority: this.priority,
        });
    }
    async run(ctx) {
        await checkoutDetached(ctx.work, ctx.commit);
        const command = renderCommand(this.command, this.relatedTemplate, ctx.changedFiles);
        let started = Date.now();
        const r = await withCheckSlot(this.slots === undefined ? checkSlotsFromEnv() : this.slots, () => {
            started = Date.now();
            return runCommand(niced(["sh", "-c", command]), { cwd: ctx.work, timeoutMs: this.timeoutMs, env: this.env });
        }, { priority: this.priority });
        const passed = !r.timedOut && r.code === 0;
        let excerpt = excerptOf(r.output);
        if (r.timedOut)
            excerpt = `timeout: check exceeded ${this.timeoutMs} ms\n${excerpt}`.trimEnd();
        else if (!passed && r.signal)
            excerpt = `${excerpt}\nkilled by ${r.signal}`.trim();
        return {
            id: this.id,
            passed,
            failedTests: passed ? [] : this.parse(r.stdout, r.stderr),
            excerpt,
            durationMs: Date.now() - started,
            cached: false,
            ...(r.timedOut ? { timedOut: true } : {}),
        };
    }
}
export class CheckCache {
    sql;
    remote;
    constructor(sql, remote) {
        this.sql = sql;
        this.remote = remote;
        sql.exec("CREATE TABLE IF NOT EXISTS check_cache (tree TEXT NOT NULL, check_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (tree, check_id))");
        sql.exec("CREATE TABLE IF NOT EXISTS check_inflight (key TEXT NOT NULL, check_id TEXT NOT NULL, started_at INTEGER NOT NULL, PRIMARY KEY (key, check_id))");
        sql.exec("CREATE TABLE IF NOT EXISTS check_wanted (key TEXT NOT NULL, check_id TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (key, check_id))");
    }
    /**
     * Whether an integrator is waiting for this in-flight verdict (`awaitInflight`): a pre-verification still waiting for
     * a check slot then takes one with the integrators' priority instead of its own (slots.ts), so the integrator does
     * not wait behind its own checks for work it chose to wait for.
     */
    /** Mark an in-flight verdict as awaited without waiting here (an integrator deferred the submission for it). */
    want(key, checkId) {
        this.sql.exec("INSERT OR REPLACE INTO check_wanted (key, check_id, since) VALUES (?, ?, ?)", key, checkId, Date.now());
    }
    isWanted(key, checkId) {
        return this.sql.exec("SELECT 1 FROM check_wanted WHERE key = ? AND check_id = ?", key, checkId).length > 0;
    }
    /** Record that a verdict for `key` is being computed on this machine (an agent's pre-verification); storing it clears the mark. */
    markRunning(key, checkId, now = Date.now()) {
        this.sql.exec("INSERT OR REPLACE INTO check_inflight (key, check_id, started_at) VALUES (?, ?, ?)", key, checkId, now);
    }
    clearRunning(key, checkId) {
        this.sql.exec("DELETE FROM check_inflight WHERE key = ? AND check_id = ?", key, checkId);
    }
    /** When a verdict for `key` is being computed: the time that started, else null. */
    runningSince(key, checkId) {
        const row = this.sql.exec("SELECT started_at FROM check_inflight WHERE key = ? AND check_id = ?", key, checkId)[0];
        return row ? Number(row.started_at) : null;
    }
    /**
     * A verdict being computed elsewhere on this machine (`markRunning`) is worth waiting for instead of computing
     * it again: polls until it is stored, or until `maxMs` after it started. Null at once when nothing is in flight,
     * and null when the wait runs out (the mark is then dropped as stale).
     */
    async awaitInflight(key, checkId, opts) {
        const now = opts.now ?? Date.now;
        if (this.runningSince(key, checkId) === null)
            return null;
        this.sql.exec("INSERT OR REPLACE INTO check_wanted (key, check_id, since) VALUES (?, ?, ?)", key, checkId, now());
        try {
            for (;;) {
                const hit = await this.fetch(key, checkId);
                if (hit)
                    return hit;
                // The mark is refreshed when the run actually starts (after waiting for a check slot): measure from that.
                const since = this.runningSince(key, checkId);
                if (since === null)
                    return await this.fetch(key, checkId);
                if (now() >= since + opts.maxMs) {
                    this.clearRunning(key, checkId);
                    return null;
                }
                await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 1000));
            }
        }
        finally {
            this.sql.exec("DELETE FROM check_wanted WHERE key = ? AND check_id = ?", key, checkId);
        }
    }
    get(tree, checkId) {
        const rows = this.sql.exec("SELECT result FROM check_cache WHERE tree = ? AND check_id = ?", tree, checkId);
        const row = rows[0];
        if (!row)
            return null;
        const stored = JSON.parse(String(row.result));
        if (inconclusive(stored))
            return null;
        return { ...stored, id: checkId, cached: true };
    }
    hasRemote() {
        return this.remote !== undefined;
    }
    /** Local first, then the control plane for a closure key; a remote hit is stored locally without output. */
    async fetch(key, checkId) {
        const local = this.get(key, checkId);
        if (local || !this.remote || !key.startsWith("closure:"))
            return local;
        try {
            const v = await this.remote.client.getVerdict(this.remote.repoId, key, checkId);
            if (!v)
                return null;
            const result = {
                id: checkId,
                passed: v.passed,
                failedTests: v.failedTests,
                excerpt: v.passed ? "" : `${v.failedTests.length} test(s) failed on a tree with this dependency closure (verdict shared through the control plane)`,
                durationMs: v.durationMs,
                cached: false,
            };
            this.put(key, checkId, result);
            return { ...result, cached: true };
        }
        catch {
            return null;
        }
    }
    /** Store locally and share a closure-keyed verdict through the control plane; sharing is best effort. */
    async publish(key, checkId, r) {
        if (inconclusive(r))
            return;
        this.put(key, checkId, r);
        if (!this.remote || !key.startsWith("closure:"))
            return;
        try {
            await this.remote.client.putVerdict(this.remote.repoId, { key, checkId, passed: r.passed, failedTests: r.failedTests, durationMs: r.durationMs });
        }
        catch {
            // The local cache still has it; the next integrator re-runs at worst.
        }
    }
    /** Whether any closure-addressed verdict is stored or in flight (the executor builds no index until one is). */
    hasClosureKeys() {
        const rows = this.sql.exec("SELECT 1 AS present FROM check_cache WHERE tree LIKE 'closure:%' LIMIT 1");
        if (rows.length > 0)
            return true;
        return this.sql.exec("SELECT 1 AS present FROM check_inflight WHERE key LIKE 'closure:%' LIMIT 1").length > 0;
    }
    put(tree, checkId, r) {
        if (inconclusive(r))
            return;
        const stored = { ...r, id: checkId, cached: false };
        this.sql.exec("INSERT OR REPLACE INTO check_cache (tree, check_id, result) VALUES (?, ?, ?)", tree, checkId, JSON.stringify(stored));
        this.clearRunning(tree, checkId);
    }
}
/**
 * Run checks in order against one candidate, consulting the cache first (by the closure key when the caller has
 * one, then by the tree); stops at the first failure. A fresh result is stored under both keys.
 */
export async function runChecks(checks, cache, ctx) {
    const results = [];
    for (const check of checks) {
        let result = (ctx.key ? await cache.fetch(ctx.key, check.id) : null) ?? cache.get(ctx.tree, check.id);
        if (!result) {
            result = await check.run({ work: ctx.work, commit: ctx.commit, changedFiles: ctx.changedFiles });
            cache.put(ctx.tree, check.id, result);
            if (ctx.key)
                await cache.publish(ctx.key, check.id, result);
        }
        results.push(result);
        if (!result.passed)
            break;
    }
    return results;
}
//# sourceMappingURL=checks.js.map