// Workspace helpers for the verification planner: package lookup, the toolchain (pnpm, npm or yarn, with or without
// turbo), per-package test and type-check invocation, and builds through turbo's cache.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkSlotsFromEnv } from "../executor/slots.js";
import { packageProfile, readProfile } from "./profile.js";
const run = promisify(execFile);
/** `packages/<x>` for a path inside a package, else null (the layout of workers-sdk; see `packageDirIn` for any layout). */
export function packageDirOf(path) {
    const m = /^(packages\/[^/]+)\//.exec(path);
    return m ? m[1] : null;
}
/** The deepest of `dirs` (package directories, "." for the root package) that contains `path`, else null. */
export function packageDirIn(path, dirs) {
    let best = null;
    for (const dir of dirs) {
        const inside = dir === "." || dir === "" ? true : path.startsWith(`${dir}/`);
        if (inside && (best === null || best === "." || dir.length > best.length))
            best = dir;
    }
    return best;
}
/** A path inside a package, joined back to a repository-relative path. */
export const inPackage = (dir, rel) => (dir === "." || dir === "" ? rel : `${dir}/${rel}`);
/**
 * Group repo-relative files by package directory (relative to it). Without `dirs`, packages are `packages/<x>` and
 * files outside them are dropped; with `dirs`, each file goes to the deepest package containing it.
 */
export function groupByPackage(files, dirs) {
    const out = new Map();
    for (const f of files) {
        const dir = dirs ? packageDirIn(f, dirs) : packageDirOf(f);
        if (!dir)
            continue;
        const rel = dir === "." ? f : f.slice(dir.length + 1);
        out.set(dir, [...(out.get(dir) ?? []), rel]);
    }
    return out;
}
export function detectToolchain(repo) {
    let pm = "npm";
    try {
        const manager = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).packageManager ?? "";
        if (manager.startsWith("pnpm@"))
            pm = "pnpm";
        else if (manager.startsWith("yarn@"))
            pm = "yarn";
    }
    catch {
        // no root manifest
    }
    if (pm === "npm" && existsSync(join(repo, "pnpm-lock.yaml")))
        pm = "pnpm";
    if (pm === "npm" && existsSync(join(repo, "yarn.lock")))
        pm = "yarn";
    return { pm, turbo: existsSync(join(repo, "turbo.json")) };
}
export function readPackage(repo, dir) {
    let name = dir === "." ? "root" : dir;
    let scripts = {};
    try {
        const pkg = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8"));
        if (pkg.name)
            name = pkg.name;
        scripts = pkg.scripts ?? {};
    }
    catch {
        // no manifest: a directory of sources
    }
    return { dir, name, hasNodeOptionsScript: existsSync(join(repo, dir, "scripts", "node-options-for-tests.js")), scripts };
}
export function pnpmVersion(repo) {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const m = /^pnpm@(\S+)$/.exec(pkg.packageManager ?? "");
    return m ? m[1] : "10";
}
export async function exec(cmd, args, opts) {
    try {
        const { stdout, stderr } = await run(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 30 * 60 * 1000 });
        return { code: 0, stdout, stderr };
    }
    catch (error) {
        const e = error;
        return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(error) };
    }
}
/** Environment for commands in a prepared monorepo checkout: shared turbo cache, no telemetry, no update checks. */
export function monorepoEnv(turboCacheDir, storeDir) {
    // No DO_NOT_TRACK: wrangler's own telemetry tests read it and forty of them fail when it is set; turbo's telemetry
    // is silenced by TURBO_TELEMETRY_DISABLED alone.
    return { TURBO_CACHE_DIR: turboCacheDir, TURBO_TELEMETRY_DISABLED: "1", TURBO_UI: "0", CI: "1", npm_config_store_dir: storeDir, COREPACK_ENABLE_STRICT: "0" };
}
/**
 * A check's share of the machine when several run at once (COMMONS_CHECK_SLOTS): turbo's task concurrency and vitest's
 * workers, so that N slots do not each assume they have every core. Builds and type checks are mostly single-threaded
 * per package, so turbo gets twice the even share; tests are a small part of a check. Empty without slots.
 */
export function checkShare(env = {}, cpus = availableParallelism()) {
    // `env` holds overrides on top of this process's environment, as exec() applies them.
    const slots = checkSlotsFromEnv({ ...process.env, ...env });
    if (!slots || slots.count <= 1)
        return { turbo: [], vitest: [] };
    return {
        turbo: [`--concurrency=${Math.max(2, Math.ceil((2 * cpus) / slots.count))}`],
        vitest: [`--maxWorkers=${Math.max(1, Math.floor(cpus / slots.count))}`],
    };
}
export function pnpmArgs(repo, args) {
    return { cmd: "npx", args: [`pnpm@${pnpmVersion(repo)}`, ...args] };
}
/**
 * Build the dependencies of `names` through turbo (restored from its cache), then, for packages with a `selfBuild`
 * command, run that command in the package instead of its full `build` script. A package's `build` may type-check
 * its tests (miniflare does), and hidden or in-progress tests must fail individually under vitest, not take the whole
 * package's build down with them.
 */
/** Build the named packages themselves (their dependencies come from the cache or are built first). */
export async function buildSelf(repo, names, env) {
    if (names.length === 0)
        return { code: 0, stdout: "", stderr: "" };
    const p = pnpmArgs(repo, ["exec", "turbo", "build", ...names.map((n) => `--filter=${n}`), "--output-logs=errors-only", ...checkShare(env).turbo]);
    return exec(p.cmd, p.args, { cwd: repo, env });
}
/** Build every package that depends on `names` (and `names` themselves), so a later `--only` type check finds them built. */
export async function buildDependents(repo, names, env) {
    return buildFilters(repo, names.map((n) => `--filter=...${n}`), env);
}
/** `turbo build` over explicit filters (`--filter=x` for a package, `--filter=...x` for it and its dependents). */
export async function buildFilters(repo, filters, env) {
    if (filters.length === 0)
        return { code: 0, stdout: "", stderr: "" };
    const p = pnpmArgs(repo, ["exec", "turbo", "build", ...filters, "--output-logs=errors-only", ...checkShare(env).turbo]);
    return exec(p.cmd, p.args, { cwd: repo, env });
}
/** `turbo check:type --only` over explicit filters: just the type checks, every build having happened already. */
export async function typeCheckFilters(repo, filters, env, opts = {}) {
    if (filters.length === 0)
        return { code: 0, stdout: "", stderr: "" };
    const p = pnpmArgs(repo, ["exec", "turbo", "check:type", ...filters, "--output-logs=errors-only", "--only", ...(opts.force ? ["--force"] : []), ...checkShare(env).turbo]);
    const r = await exec(p.cmd, p.args, { cwd: repo, env });
    if (r.code !== 0 && /could not find task|missing task|task .* not found|no tasks? .* found/i.test(`${r.stdout}\n${r.stderr}`)) {
        return { code: 0, stdout: r.stdout, stderr: r.stderr, skipped: true };
    }
    return r;
}
export async function buildPackages(repo, names, selfBuild, env, pkgs) {
    if (names.length === 0)
        return { code: 0, stdout: "", stderr: "" };
    const filters = names.map((n) => `--filter=${n}^...`);
    const p = pnpmArgs(repo, ["exec", "turbo", "build", ...filters, "--output-logs=errors-only", ...checkShare(env).turbo]);
    const deps = await exec(p.cmd, p.args, { cwd: repo, env });
    if (deps.code !== 0)
        return deps;
    for (const name of names) {
        const cmd = selfBuild[name];
        if (!cmd || cmd.length === 0)
            continue;
        const dir = pkgs?.find((x) => x.name === name)?.dir;
        if (!dir)
            continue;
        const r = await exec(cmd[0], cmd.slice(1), { cwd: join(repo, dir), env });
        if (r.code !== 0)
            return { ...r, stderr: `${name} self build (${cmd.join(" ")}) failed:\n${r.stderr}` };
    }
    return deps;
}
/** `vitest <mode> --run <files>` inside one package with that package's test environment. */
/**
 * Type-check `names` and every package that depends on them (`turbo check:type --filter=...pkg`): a change that
 * compiles in its own package can still break a dependent's declarations (a union gaining a member that another
 * package indexes a map by), and related tests do not type-check across packages. Turbo caches the untouched
 * dependents, so the cost is the packages whose inputs changed. A repository without a `check:type` task is skipped.
 */
/**
 * Type-check the touched packages and every package that depends on them (`check:type`, `--filter=...pkg`). The
 * dependents are the point: in the fifth run a workers-auth change widened a union that wrangler indexes a table by,
 * passed a check of workers-auth alone, landed, and broke wrangler for every later submission. (Checking dependents
 * failed earlier only because the base copy lacked `.github/`, which `@cloudflare/tools` imports.)
 */
export async function typeCheckPackages(repo, names, env, opts = {}) {
    if (names.length === 0)
        return { code: 0, stdout: "", stderr: "" };
    const filters = names.map((n) => (opts.dependents === false ? `--filter=${n}` : `--filter=...${n}`));
    // --only: just the check:type tasks, not the builds they depend on (the caller built everything already; a cached
    // build replays its outputs, which must not happen while tests read them).
    const p = pnpmArgs(repo, ["exec", "turbo", "check:type", ...filters, "--output-logs=errors-only", ...(opts.only ? ["--only"] : []), ...checkShare(env).turbo]);
    const r = await exec(p.cmd, p.args, { cwd: repo, env });
    if (r.code !== 0 && /could not find task|missing task|task .* not found|no tasks? .* found/i.test(`${r.stdout}\n${r.stderr}`)) {
        return { code: 0, stdout: r.stdout, stderr: r.stderr, skipped: true };
    }
    return r;
}
export async function vitestInPackage(repo, pkg, mode, files, extra, env) {
    const testEnv = { ...env };
    if (pkg.hasNodeOptionsScript) {
        const r = await exec("node", ["scripts/node-options-for-tests.js"], { cwd: join(repo, pkg.dir), env });
        if (r.code === 0 && r.stdout.trim())
            testEnv.NODE_OPTIONS = r.stdout.trim();
    }
    // CI splits a check's worker share across package suites; vitest rejects two --maxWorkers arguments.
    const workers = extra.some((arg) => arg.startsWith("--maxWorkers=")) ? [] : checkShare(env).vitest;
    const args = ["vitest", mode, ...(mode === "related" ? ["--run"] : []), ...workers, ...(readProfile(repo).vitestArgs ?? []), ...extra, ...files];
    if (detectToolchain(repo).pm === "pnpm" && pkg.dir !== ".") {
        const p = pnpmArgs(repo, ["--filter", pkg.name, "exec", ...args]);
        return exec(p.cmd, p.args, { cwd: repo, env: testEnv });
    }
    return exec("npx", ["--no-install", ...args], { cwd: join(repo, pkg.dir), env: testEnv });
}
/**
 * Type-check one package without turbo: its `check:type` or `typecheck` script, else `tsc --noEmit` on its
 * tsconfig.json; skipped when it has neither.
 */
export async function typeCheckPlain(repo, pkg, env) {
    const cwd = join(repo, pkg.dir);
    // The project profile's command for this package, when adaptation found a better one (or none to run).
    const own = packageProfile(repo, pkg.dir).typecheck;
    if (own === null)
        return { code: 0, stdout: "", stderr: "", skipped: true };
    if (own && own.length > 0)
        return { ...(await exec(own[0], own.slice(1), { cwd, env })), command: own.join(" ") };
    const script = ["check:type", "typecheck", "type-check"].find((s) => pkg.scripts?.[s]);
    if (script) {
        const pm = detectToolchain(repo).pm;
        const r = pm === "pnpm" ? await exec(pnpmArgs(repo, ["run", script]).cmd, pnpmArgs(repo, ["run", script]).args, { cwd, env }) : await exec(pm, ["run", script], { cwd, env });
        return { ...r, command: `${pm} run ${script}` };
    }
    if (existsSync(join(cwd, "tsconfig.json")))
        return { ...(await exec("npx", ["--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"], { cwd, env })), command: "tsc --noEmit" };
    return { code: 0, stdout: "", stderr: "", skipped: true };
}
//# sourceMappingURL=workspace.js.map