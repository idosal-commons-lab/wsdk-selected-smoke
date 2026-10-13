// The verification planner: what a change needs checked, and the check itself, for any JavaScript or TypeScript
// repository (one package or a pnpm, npm or yarn workspace, with or without turbo), and Python projects.
//
//   commons check related <files...>    check what the given changed files need
//   commons check since [<rev>]         check everything changed since <rev> (default: the nearest recorded base)
//   commons check plan <files...>       print what would run and why, without building or running anything
//   commons check map [--packages a,b]  record the base (declaration surfaces, function-coverage maps) at HEAD
//   commons check ci <files...>         build, type-check and run affected packages' full suites
//   commons check ci-base [dirs...]     record full-suite base failures at HEAD, once per package
//
// Per touched package: builds its dependencies and itself through turbo's cache (workspaces with turbo), then
// type-checks it side by side with its tests. Its dependents are type-checked only when its declaration surface
// changed, and only those that use a changed declaration (dependents.ts). Its tests are the ones that executed a
// changed function on the recorded base (tia.ts), else `vitest related`. Records come from `commons check map` (or the
// benchmark's prepare step) and are looked up as the nearest recorded ancestor of HEAD (records.ts).
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { changedDeclarations, declarationIndex, directDependents, selectDependents, workspacePackages } from "./dependents.js";
import { nearestBase, readBaseSurfaces, readCiBase, readTiaMap, rootCommit, verifyDir, writeCiBase } from "./records.js";
import { buildOverrides, checkEnv, readProfile, recordsDirOf } from "./profile.js";
import { declarationSurface } from "./surface.js";
import { baseHunks, functionSpans, selectDependentTests, selectTests } from "./tia.js";
import { parseFailedTests, stripAnsi } from "../executor/checks.js";
import { groupWithPython, isPythonPackage, pythonPackageDirs, runPythonTests, selectPythonTests } from "./python.js";
import { buildFilters, buildPackages, buildSelf, checkShare, detectToolchain, exec, groupByPackage, inPackage, readPackage, typeCheckFilters, typeCheckPlain, vitestInPackage, } from "./workspace.js";
const run = promisify(execFile);
/**
 * What a failed build printed, for the verdict: turbo writes the failing task's own output (the compiler's errors) to
 * stdout and only its summary to stderr. The errors first, then the end of the output, at most 6000 characters.
 */
export function failureOutput(r) {
    const all = `${r.stdout}\n${r.stderr}`;
    const errors = all.split("\n").filter((l) => /error TS\d+|\berror\b|ERROR|✘|Cannot find|is not assignable|has no exported member/i.test(l));
    const head = errors.slice(0, 40).join("\n");
    return `${head}${head ? "\n...\n" : ""}${all.slice(-Math.max(1000, 6000 - head.length))}`.slice(0, 7000);
}
/** The project profile's build commands, by package name. */
export function selfBuildOf(repo) {
    return buildOverrides(repo, (dir) => {
        try {
            return readPackage(repo, dir).name;
        }
        catch {
            return null;
        }
    });
}
/** Options with the project's defaults filled in: its records directory and build commands. */
export function resolveOptions(repo, opts = {}) {
    return { ...opts, recordsDir: opts.recordsDir ?? recordsDirOf(repo), selfBuild: opts.selfBuild ?? selfBuildOf(repo) };
}
/**
 * Package directories of a repository: its JS workspace packages (or single-package root), plus Python project roots.
 * In a workspace, files outside every package (changesets, CI configuration, docs) are not checked.
 */
export function packageDirs(repo, packages = workspacePackages(repo)) {
    // One runner config at the root covers every package (project profile): the repository is one unit.
    if (readProfile(repo).layout === "root" && existsSync(join(repo, "package.json")))
        return [...new Set([".", ...pythonPackageDirs(repo)])];
    const js = packages.length > 0 ? packages.map((p) => p.dir) : existsSync(join(repo, "package.json")) ? ["."] : [];
    return [...new Set([...js, ...pythonPackageDirs(repo)])];
}
/** The base a check compares against: the given one, the nearest recorded ancestor, else the root commit. */
export function baseFor(repo, opts = {}) {
    if (opts.base)
        return opts.base;
    return nearestBase(repo, opts.recordsDir ?? recordsDirOf(repo)) ?? rootCommit(repo) ?? "HEAD";
}
export async function changedSince(repo, base) {
    const out = (await run("git", ["-C", repo, "diff", "--relative", "--name-only", base, "HEAD"], { maxBuffer: 64 * 1024 * 1024 })).stdout;
    return out.split("\n").filter(Boolean);
}
/** Everything changed since the root commit (the benchmark's base). */
export async function changedSinceBase(repo) {
    return changedSince(repo, rootCommit(repo) ?? "HEAD");
}
/** The tests a package's change needs: by the base's function coverage when it recorded a map, else `vitest related`. */
export async function testsToRun(repo, base, pkg, rel, recordsDir) {
    const map = process.env.COMMONS_TIA !== "0" ? readTiaMap(base, pkg.dir, recordsDir) : null;
    const python = isPythonPackage(repo, pkg.dir);
    if (!map && python)
        return { by: "all", why: `no function-coverage map of ${pkg.dir} at ${base.slice(0, 12)}` };
    if (!map)
        return { by: "related", files: rel, why: `no function-coverage map of ${pkg.dir} at ${base.slice(0, 12)}` };
    const diff = (await run("git", ["-C", repo, "diff", "--relative", "-U0", base, "--", pkg.dir], { maxBuffer: 256 * 1024 * 1024 })).stdout;
    const read = (file, side) => {
        try {
            return side === "current"
                ? readFileSync(join(repo, pkg.dir, file), "utf8")
                : execFileSync("git", ["-C", repo, "show", `${base}:./${inPackage(pkg.dir, file)}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        }
        catch {
            return null;
        }
    };
    return {
        by: "coverage",
        selection: python ? selectPythonTests(map, rel, baseHunks(diff), pkg.dir, read, join(repo, pkg.dir)) : selectTests(map, rel, baseHunks(diff), pkg.dir, read),
        total: map.tests.length,
        ...(map.baseFailures?.length ? { baseFailures: map.baseFailures } : {}),
    };
}
/** Every coverage map recorded at `base`. */
export function mapsAt(base, recordsDir = verifyDir()) {
    const dir = join(recordsDir, "tia", base);
    let names;
    try {
        names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        try {
            out.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
        }
        catch {
            // unreadable map
        }
    }
    return out;
}
/**
 * Cross-package selection: for every other package whose coverage map recorded its tests executing this package's
 * code (through its built bundles), the test files that executed a changed function of it.
 */
export async function dependentTestsToRun(repo, base, pkg, rel, recordsDir) {
    if (process.env.COMMONS_DEPENDENT_TESTS === "0")
        return [];
    const maps = mapsAt(base, recordsDir).filter((m) => m.packageDir !== pkg.dir);
    if (maps.length === 0)
        return [];
    const diff = (await run("git", ["-C", repo, "diff", "--relative", "-U0", base, "--", pkg.dir], { maxBuffer: 256 * 1024 * 1024 })).stdout;
    const hunks = baseHunks(diff);
    const read = (file, side) => {
        try {
            return side === "current"
                ? readFileSync(join(repo, pkg.dir, file), "utf8")
                : execFileSync("git", ["-C", repo, "show", `${base}:./${inPackage(pkg.dir, file)}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        }
        catch {
            return null;
        }
    };
    const own = readTiaMap(base, pkg.dir, recordsDir);
    const spansOf = (file) => {
        if (own?.functions[file])
            return own.functions[file];
        const code = read(file, "base");
        return code === null ? null : functionSpans(code, file);
    };
    const out = [];
    for (const m of maps) {
        const sel = selectDependentTests(m, pkg.dir, rel, hunks, spansOf, read, readProfile(repo).limits?.maxDependentTests);
        if (sel.run.length > 0)
            out.push({ packageDir: m.packageDir, files: sel.run, notes: sel.notes, ...(m.baseFailures?.length ? { baseFailures: m.baseFailures } : {}) });
    }
    return out;
}
/** The test files named by a run's failures (`<file> > <suite> > <test>`), relative to the package. */
export function failingTestFiles(failed) {
    return [...new Set(failed.map((name) => name.split(" > ")[0].trim()).filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)))];
}
// The verdict parser caps its excerpt at 40 failures; quarantine must see every failure in a full suite.
function suiteFailures(r) {
    const lines = stripAnsi(`${r.stdout}\n${r.stderr}`).split(/\r?\n/);
    // Vitest also prints bare test titles beside each file; its FAIL summary has the unambiguous file + suite name.
    const headers = lines.filter((line) => /^\s*FAIL\s/.test(line));
    const failures = lines.some((line) => /^\s*Test Files\s/.test(line)) && headers.length ? headers : lines;
    return [...new Set(failures.flatMap((line) => parseFailedTests(line, "")))];
}
/**
 * Second chances for a failed test run: failures the base itself has (its coverage run recorded them) do not count
 * against a change, and the failing test files run once more by themselves, a pass there marking them flaky. Real
 * failures cost one rerun of just the failing files. COMMONS_RETRY_FLAKY=0 turns the rerun off.
 */
export async function secondChance(repo, pkg, first, env, log, baseFailures = [], extra = ["--passWithNoTests"]) {
    if (first.code === 0)
        return first;
    const failed = suiteFailures(first);
    if (failed.length === 0)
        return first;
    const known = new Set(baseFailures);
    const fresh = failed.filter((f) => !known.has(f));
    if (fresh.length === 0) {
        log(`${failed.length} failing test(s) of ${pkg.name} fail on the base too; not held against the change`);
        return { ...first, code: 0, note: "failures the base has too" };
    }
    if (process.env.COMMONS_RETRY_FLAKY === "0")
        return first;
    const files = failingTestFiles(fresh);
    if (files.length === 0 || files.length > 8)
        return first;
    // Without --passWithNoTests: a rerun that finds none of the files ran nothing and proves nothing (vitest projects
    // label failing tests "|unit| file > case", and before that label was stripped such reruns "passed").
    const again = await vitestInPackage(repo, pkg, "run", files, extra.filter((a) => a !== "--passWithNoTests"), env);
    const retryFailures = suiteFailures(again);
    if (again.code !== 0 && !(retryFailures.length > 0 && retryFailures.every((f) => known.has(f))))
        return { ...first, stdout: `${first.stdout}\n${again.stdout}`, stderr: `${first.stderr}\n${again.stderr}` };
    log(`flaky: ${files.length} failing test file(s) of ${pkg.name} passed when run again (${fresh.slice(0, 3).join("; ")})`);
    return { ...again, stdout: `${first.stdout}\n${again.stdout}`, stderr: `${first.stderr}\n${again.stderr}`, code: 0, note: `flaky on a first run: ${files.join(", ")}` };
}
/**
 * Run tests and judge them with second chances. With COMMONS_CHECK_BAIL=1 (integrators set it: they need pass or fail,
 * not every failure) vitest stops at the first failing test; when second chances excuse that failure (the base has it,
 * or it passes again), the selection runs once more without stopping, so a stop never hides a later failure.
 */
async function testsOnce(repo, pkg, mode, files, extra, env, log, baseFailures = []) {
    const bail = process.env.COMMONS_CHECK_BAIL === "1";
    const first = await vitestInPackage(repo, pkg, mode, files, [...extra, ...(bail ? ["--bail=1"] : [])], env);
    const judged = await secondChance(repo, pkg, first, env, log, baseFailures);
    if (!bail || first.code === 0 || judged.code !== 0)
        return judged;
    log(`${pkg.name}: the failure that stopped the run is excused (${judged.note ?? "second chance"}); running the rest`);
    return secondChance(repo, pkg, await vitestInPackage(repo, pkg, mode, files, extra, env), env, log, baseFailures);
}
async function runDependentTests(repo, deps, env, log) {
    if (deps.length === 0)
        return { code: 0, stdout: "", stderr: "", note: "" };
    const parts = await Promise.all(deps.map(async (d) => {
        const dpkg = readPackage(repo, d.packageDir);
        log(`tests of ${dpkg.name} that executed the changed code: ${d.files.length} test file(s)`);
        for (const note of d.notes)
            log(`  ${note}`);
        return testsOnce(repo, dpkg, "run", d.files, ["--passWithNoTests"], env, log, d.baseFailures);
    }));
    return {
        code: Math.max(0, ...parts.map((p) => p.code)),
        stdout: parts.map((p) => p.stdout).join("\n"),
        stderr: parts.map((p) => p.stderr).join("\n"),
        note: deps.map((d) => `${d.files.length} test file(s) of ${readPackage(repo, d.packageDir).name}`).join(", "),
    };
}
/** What a check of `files` would run, without building or running anything. */
export async function planCheck(repo, files, given = {}) {
    const opts = resolveOptions(repo, given);
    const packages = readProfile(repo).layout === "root" ? [] : workspacePackages(repo);
    const dirs = packageDirs(repo, packages);
    const groups = groupWithPython(files, dirs, pythonPackageDirs(repo));
    const grouped = new Set([...groups].flatMap(([dir, rel]) => rel.map((r) => inPackage(dir, r))));
    const base = baseFor(repo, opts);
    const surfaces = readBaseSurfaces(base, opts.recordsDir);
    const out = [];
    for (const [dir, rel] of groups) {
        const pkg = readPackage(repo, dir);
        out.push({
            package: pkg.name,
            dir,
            files: rel,
            tests: await testsToRun(repo, base, pkg, rel, opts.recordsDir),
            ...(isPythonPackage(repo, dir) ? { language: "python" } : {}),
            surfaceRecorded: Boolean(surfaces?.[pkg.name]),
            dependents: directDependents(packages, pkg.name).map((p) => p.name),
            dependentTests: await dependentTestsToRun(repo, base, pkg, rel, opts.recordsDir),
        });
    }
    return { base, toolchain: detectToolchain(repo), packages: out, outside: files.filter((f) => !grouped.has(f)) };
}
/** A human-readable rendering of a plan. */
export function formatPlan(plan) {
    const lines = [`base ${plan.base.slice(0, 12)}, ${plan.toolchain.pm}${plan.toolchain.turbo ? " with turbo" : ""}`];
    for (const p of plan.packages) {
        lines.push(`${p.package} (${p.dir}): ${p.files.length} changed file(s)`);
        if (p.tests.by === "coverage") {
            const s = p.tests.selection;
            lines.push(`  tests by function coverage: ${s.run.length} of ${p.tests.total} test file(s)${s.related.length ? `, related tests for ${s.related.length} file(s)` : ""}`);
            for (const t of s.run.slice(0, 20))
                lines.push(`    ${t}`);
            if (s.run.length > 20)
                lines.push(`    ... ${s.run.length - 20} more`);
            for (const n of s.notes)
                lines.push(`  ${n}`);
        }
        else
            lines.push(`  ${p.tests.by === "all" ? "all tests" : "related tests"} (${p.tests.why})`);
        for (const d of p.dependentTests) {
            lines.push(`  tests of ${d.packageDir} that executed the changed code: ${d.files.length}`);
            for (const t of d.files.slice(0, 10))
                lines.push(`    ${t}`);
        }
        if (p.language === "python")
            lines.push("  type check: none (Python)");
        else if (p.dependents.length)
            lines.push(`  type check: itself${p.surfaceRecorded ? ", and the dependents that use a changed declaration if its surface changed" : ` and all ${p.dependents.length} dependent(s) (no recorded surface)`}`);
        else
            lines.push("  type check: itself");
    }
    if (plan.outside.length)
        lines.push(`outside any package (not checked): ${plan.outside.join(", ")}`);
    return lines.join("\n");
}
async function runTests(repo, pkg, tests, env, log) {
    if (isPythonPackage(repo, pkg.dir)) {
        if (tests.by !== "coverage")
            return { ...(await runPythonTests(join(repo, pkg.dir))), note: "all tests" };
        const sel = tests.selection;
        log(`tests of ${pkg.name} by function coverage: ${sel.run.length} of ${tests.total} test file(s)`);
        for (const note of sel.notes)
            log(`  ${note}`);
        return { ...(await runPythonTests(join(repo, pkg.dir), sel.run)), note: `${sel.run.length} of ${tests.total} test files by coverage` };
    }
    if (tests.by === "all")
        throw new Error("all-suite selection requires a Python package");
    if (tests.by === "related") {
        const r = await testsOnce(repo, pkg, "related", tests.files, [], env, log);
        return { ...r, note: `related tests${r.note ? ` (${r.note})` : ""}` };
    }
    const sel = tests.selection;
    log(`tests of ${pkg.name} by function coverage: ${sel.run.length} of ${tests.total} test file(s)${sel.related.length ? `, plus related tests for ${sel.related.length} file(s) the map cannot place` : ""}`);
    for (const note of sel.notes)
        log(`  ${note}`);
    const parts = await Promise.all([
        sel.run.length ? testsOnce(repo, pkg, "run", sel.run, ["--passWithNoTests"], env, log, tests.baseFailures) : null,
        sel.related.length ? testsOnce(repo, pkg, "related", sel.related, [], env, log, tests.baseFailures) : null,
    ]);
    const ran = parts.filter((p) => p !== null);
    const notes = ran.flatMap((p) => (p.note ? [p.note] : []));
    return {
        code: Math.max(0, ...ran.map((p) => p.code)),
        stdout: ran.map((p) => p.stdout).join("\n"),
        stderr: ran.map((p) => p.stderr).join("\n"),
        note: `${sel.run.length} of ${tests.total} test files by coverage${sel.related.length ? ` and related tests for ${sel.related.length} file(s)` : ""}${notes.length ? ` (${notes.join("; ")})` : ""}`,
    };
}
/**
 * The type check's scope for a built package: itself when its declaration surface is unchanged since the base; with
 * the dependents that use a changed declaration when it changed and the base recorded per-declaration hashes
 * (dependents.ts); with every dependent otherwise.
 */
async function typeCheckScope(repo, pkg, baseSurfaces, packages, env, log) {
    const steps = [];
    const secs = (ms) => `${Math.round(ms / 1000)} s`;
    let t = Date.now();
    let filters = [`--filter=${pkg.name}`];
    let scopeNote = "alone";
    const record = baseSurfaces?.[pkg.name];
    const now = record ? declarationSurface(join(repo, pkg.dir)) : null;
    if (record && now === record.hash) {
        log(`declaration surface of ${pkg.name} unchanged since the base: type-checking it alone`);
    }
    else if (record?.decls && now !== null && process.env.COMMONS_NARROW_DEPENDENTS !== "0") {
        const index = declarationIndex(join(repo, pkg.dir));
        const changed = index ? changedDeclarations(record.decls, index) : null;
        if (changed) {
            t = Date.now();
            const scope = await selectDependents({
                repo,
                pkg: { name: pkg.name, dir: pkg.dir },
                changed,
                packages,
                base: baseSurfaces ?? {},
                build: async (names) => (await buildSelf(repo, names, env)).code === 0,
                surfaceOf: declarationSurface,
            });
            filters = [...filters, ...scope.alone.map((n) => `--filter=${n}`), ...scope.withDependents.map((n) => `--filter=...${n}`)];
            scopeNote = `with ${scope.alone.length + scope.withDependents.length} dependent(s) that use its ${changed.size} changed declaration(s)${scope.withDependents.length ? `, ${scope.withDependents.length} of them with their own dependents` : ""}`;
            log(`declaration surface of ${pkg.name} changed in ${changed.size} declaration(s): type-checking it ${scopeNote}`);
            for (const note of scope.notes)
                log(`  ${note}`);
            steps.push(`dependents selected in ${secs(Date.now() - t)}`);
        }
        else {
            filters = [`--filter=...${pkg.name}`];
            scopeNote = "with all dependents";
            log(`declaration surface of ${pkg.name} changed but its declarations could not be indexed: type-checking it and all its dependents`);
        }
    }
    else {
        filters = [`--filter=...${pkg.name}`];
        scopeNote = "with all dependents";
        log(`declaration surface of ${pkg.name} ${record ? (now === null ? "unavailable" : "changed, no per-declaration record") : "not recorded"}: type-checking it and all its dependents`);
    }
    return { filters, scopeNote, steps };
}
/** At most `n` of `fns` at a time, results in order. */
async function limited(fns, n) {
    const out = new Array(fns.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => {
        while (next < fns.length) {
            const i = next++;
            out[i] = await fns[i]();
        }
    }));
    return out;
}
/**
 * A check of several packages of a turbo workspace: their dependencies and themselves built in one turbo run each
 * (turbo schedules the shared graph once, where one package after another rebuilt or restored it per package), each
 * one's type-check scope decided as for a single package, then one type check over the union of scopes side by side
 * with every package's selected tests and the dependents' tests that executed changed code (three test runs at a
 * time).
 */
async function checkTogether(repo, items, o) {
    const secs = (ms) => `${Math.round(ms / 1000)} s`;
    const names = items.map((i) => i.pkg.name);
    const label = names.join(", ");
    let t = Date.now();
    const deps = await buildPackages(repo, names, o.selfBuild, o.env, items.map((i) => i.pkg));
    const depsNote = `dependencies built in ${secs(Date.now() - t)}`;
    if (deps.code !== 0) {
        o.log(`build failed for ${label}:\n${failureOutput(deps)}`);
        return { worst: deps.code, summary: names.map((n) => `${n}: ${depsNote} (with ${names.length - 1} other package(s)); build failed`) };
    }
    t = Date.now();
    const built = await buildSelf(repo, names, o.env);
    const builtNote = `built in ${secs(Date.now() - t)}`;
    if (built.code !== 0) {
        o.log(`build failed for ${label}:\n${failureOutput(built)}`);
        return { worst: built.code, summary: names.map((n) => `${n}: ${depsNote}, ${builtNote} (with ${names.length - 1} other package(s)); build failed`) };
    }
    const scopes = [];
    for (const i of items)
        scopes.push(await typeCheckScope(repo, i.pkg, o.baseSurfaces, o.packages, o.env, o.log));
    const filters = [...new Set(scopes.flatMap((sc) => sc.filters))];
    let dependentsNote = "";
    if (filters.length > items.length || filters.some((f) => f.startsWith("--filter=..."))) {
        t = Date.now();
        const dependentsBuilt = await buildFilters(repo, filters, o.env);
        dependentsNote = `, dependents built in ${secs(Date.now() - t)}`;
        if (dependentsBuilt.code !== 0) {
            o.log(`build failed for a package that depends on ${label}:\n${failureOutput(dependentsBuilt)}`);
            return { worst: dependentsBuilt.code, summary: names.map((n) => `${n}: ${depsNote}, ${builtNote}${dependentsNote}; dependents' build failed`) };
        }
    }
    const started = Date.now();
    let typesMs = 0;
    const testRuns = items.flatMap((i) => [
        async () => {
            const r = await runTests(repo, i.pkg, await testsToRun(repo, o.base, i.pkg, i.rel, o.recordsDir), o.env, o.log);
            return { pkg: i.pkg, kind: "own", r, ms: Date.now() - started };
        },
        async () => {
            const r = await runDependentTests(repo, await dependentTestsToRun(repo, o.base, i.pkg, i.rel, o.recordsDir), o.env, o.log);
            return { pkg: i.pkg, kind: "dependents", r, ms: Date.now() - started };
        },
    ]);
    const [types, runs] = await Promise.all([typeCheckFilters(repo, filters, o.env).then((x) => ((typesMs = Date.now() - started), x)), limited(testRuns, 3)]);
    let worst = 0;
    if (!types.skipped && types.code !== 0) {
        process.stdout.write(types.stdout);
        process.stderr.write(types.stderr);
        o.log(`type check failed for ${label} or a package that depends on one of them:\n${`${types.stdout}\n${types.stderr}`.slice(-4000)}`);
        worst = Math.max(worst, types.code);
    }
    const summary = [];
    items.forEach((i, k) => {
        const own = runs.find((x) => x.pkg === i.pkg && x.kind === "own");
        const dep = runs.find((x) => x.pkg === i.pkg && x.kind === "dependents");
        for (const x of [own, dep]) {
            process.stdout.write(x.r.stdout);
            process.stderr.write(x.r.stderr);
            worst = Math.max(worst, x.r.code);
        }
        summary.push(`${i.pkg.name}: ${depsNote}, ${builtNote} together with ${names.length - 1} other package(s)${scopes[k].steps.length ? `, ${scopes[k].steps.join(", ")}` : ""}${dependentsNote}, type-checked ${scopes[k].scopeNote} in one run of ${filters.length} filter(s) in ${secs(typesMs)} and ${own.r.note} ${own.r.code === 0 ? "passed" : "failed"} in ${secs(own.ms)}${dep.r.note ? `, and ${dep.r.note} that executed the changed code ${dep.r.code === 0 ? "passed" : "failed"} in ${secs(dep.ms)}` : ""}, side by side${!types.skipped && types.code !== 0 ? "; type check failed" : ""}`);
    });
    return { worst, summary };
}
export async function checkFiles(repo, files, log, given = {}) {
    const opts = resolveOptions(repo, given);
    const packages = readProfile(repo).layout === "root" ? [] : workspacePackages(repo);
    const groups = groupWithPython(files, packageDirs(repo, packages), pythonPackageDirs(repo));
    if (groups.size === 0) {
        log("no package files changed; nothing to test");
        return 0;
    }
    const toolchain = detectToolchain(repo);
    const env = checkEnv(repo);
    const base = baseFor(repo, opts);
    const baseSurfaces = process.env.COMMONS_SURFACE_GATE !== "0" ? readBaseSurfaces(base, opts.recordsDir) : null;
    const selfBuild = opts.selfBuild;
    let worst = 0;
    // One line per package at the end of the output, where the verdict's excerpt keeps it: what was checked and where
    // the time went.
    const summary = [];
    const secs = (ms) => `${Math.round(ms / 1000)} s`;
    try {
        // Several packages under turbo: one build for all of them, then every type check in one turbo run side by side
        // with every package's tests (checkTogether). One package keeps the per-package path below.
        const together = toolchain.turbo && process.env.COMMONS_PACKAGES_TOGETHER !== "0" ? [...groups.keys()].filter((d) => !isPythonPackage(repo, d)) : [];
        const handled = new Set();
        if (together.length >= 2) {
            const r = await checkTogether(repo, together.map((d) => ({ pkg: readPackage(repo, d), rel: groups.get(d) })), { base, baseSurfaces, packages, env, selfBuild, recordsDir: opts.recordsDir, log });
            worst = Math.max(worst, r.worst);
            summary.push(...r.summary);
            for (const d of together)
                handled.add(d);
        }
        for (const [dir, rel] of groups) {
            if (handled.has(dir))
                continue;
            const pkg = readPackage(repo, dir);
            const steps = [];
            if (isPythonPackage(repo, dir)) {
                const started = Date.now();
                const tests = await testsToRun(repo, base, pkg, rel, opts.recordsDir);
                const r = await runTests(repo, pkg, tests, env, log);
                process.stdout.write(r.stdout);
                process.stderr.write(r.stderr);
                summary.push(`${pkg.name}: no type check and ${r.note} ${r.code === 0 ? "passed" : "failed"} in ${secs(Date.now() - started)}`);
                worst = Math.max(worst, r.code);
                continue;
            }
            if (!toolchain.turbo) {
                // No turbo: nothing to restore from a build cache. The package's own type check and its tests, side by side.
                const started = Date.now();
                let typesMs = 0;
                let testsMs = 0;
                const [types, r] = await Promise.all([
                    typeCheckPlain(repo, pkg, env).then((x) => ((typesMs = Date.now() - started), x)),
                    testsToRun(repo, base, pkg, rel, opts.recordsDir)
                        .then((tests) => runTests(repo, pkg, tests, env, log))
                        .then((x) => ((testsMs = Date.now() - started), x)),
                ]);
                steps.push(`${types.skipped ? "no type check" : `type-checked (${types.command}) in ${secs(typesMs)}`} and ${r.note} ${r.code === 0 ? "passed" : "failed"} in ${secs(testsMs)}, side by side`);
                if (!types.skipped && types.code !== 0) {
                    log(`type check failed for ${pkg.name}:\n${`${types.stdout}\n${types.stderr}`.slice(-4000)}`);
                    worst = Math.max(worst, types.code);
                }
                process.stdout.write(r.stdout);
                process.stderr.write(r.stderr);
                summary.push(`${pkg.name}: ${steps.join(", ")}${types.code !== 0 && !types.skipped ? "; type check failed" : ""}`);
                worst = Math.max(worst, r.code);
                continue;
            }
            let t = Date.now();
            const deps = await buildPackages(repo, [pkg.name], selfBuild, env, [pkg]);
            steps.push(`dependencies built in ${secs(Date.now() - t)}`);
            if (deps.code !== 0) {
                log(`build failed for ${pkg.name}:\n${failureOutput(deps)}`);
                worst = Math.max(worst, deps.code);
                summary.push(`${pkg.name}: ${steps.join(", ")}; build failed`);
                continue;
            }
            // The package itself, built here: the type check needs it, some packages' tests import their own build output,
            // and its declaration surface decides the type check's scope.
            t = Date.now();
            const built = await buildSelf(repo, [pkg.name], env);
            steps.push(`built in ${secs(Date.now() - t)}`);
            if (built.code !== 0) {
                log(`build failed for ${pkg.name}:\n${failureOutput(built)}`);
                worst = Math.max(worst, built.code);
                summary.push(`${pkg.name}: ${steps.join(", ")}; build failed`);
                continue;
            }
            // The package and its dependents must still type-check with this change in place; related tests cannot see a
            // break in another package's declarations, and the repository's own CI would. Dependents can only break when the
            // package's declaration surface changed, and then only those that use a changed declaration (dependents.ts).
            const scope = await typeCheckScope(repo, pkg, baseSurfaces, packages, env, log);
            const filters = scope.filters;
            const scopeNote = scope.scopeNote;
            steps.push(...scope.steps);
            if (filters.length > 1 || filters[0].startsWith("--filter=...")) {
                // Every build happens before the tests start: a cached build replays its outputs into the tree.
                t = Date.now();
                const dependentsBuilt = await buildFilters(repo, filters, env);
                steps.push(`dependents built in ${secs(Date.now() - t)}`);
                if (dependentsBuilt.code !== 0) {
                    log(`build failed for a package that depends on ${pkg.name}:\n${failureOutput(dependentsBuilt)}`);
                    worst = Math.max(worst, dependentsBuilt.code);
                    summary.push(`${pkg.name}: ${steps.join(", ")}; dependents' build failed`);
                    continue;
                }
            }
            // The type check and the tests read the built tree and nothing else: run them side by side.
            const started = Date.now();
            let typesMs = 0;
            let testsMs = 0;
            let depsMs = 0;
            const [types, r, d] = await Promise.all([
                typeCheckFilters(repo, filters, env).then((x) => ((typesMs = Date.now() - started), x)),
                testsToRun(repo, base, pkg, rel, opts.recordsDir)
                    .then((tests) => runTests(repo, pkg, tests, env, log))
                    .then((x) => ((testsMs = Date.now() - started), x)),
                dependentTestsToRun(repo, base, pkg, rel, opts.recordsDir)
                    .then((deps) => runDependentTests(repo, deps, env, log))
                    .then((x) => ((depsMs = Date.now() - started), x)),
            ]);
            steps.push(`type-checked ${scopeNote} in ${secs(typesMs)} and ${r.note} ${r.code === 0 ? "passed" : "failed"} in ${secs(testsMs)}${d.note ? `, and ${d.note} that executed the changed code ${d.code === 0 ? "passed" : "failed"} in ${secs(depsMs)}` : ""}, side by side`);
            if (d.note) {
                process.stdout.write(d.stdout);
                process.stderr.write(d.stderr);
                worst = Math.max(worst, d.code);
            }
            if (types.skipped)
                log(`no check:type task; type check of ${pkg.name} and its dependents skipped`);
            else if (types.code !== 0) {
                process.stdout.write(types.stdout);
                process.stderr.write(types.stderr);
                log(`type check failed for ${pkg.name} or a package that depends on it:\n${`${types.stdout}\n${types.stderr}`.slice(-4000)}`);
                worst = Math.max(worst, types.code);
            }
            process.stdout.write(r.stdout);
            process.stderr.write(r.stderr);
            summary.push(`${pkg.name}: ${steps.join(", ")}${types.code !== 0 && !types.skipped ? "; type check failed" : ""}`);
            worst = Math.max(worst, r.code);
        }
    }
    finally {
        for (const line of summary)
            log(`summary: ${line}`);
    }
    return worst;
}
/** Workspaces with packages/* use that CI filter, excluding fixtures, tools and nested playground packages. */
function ciPackages(repo) {
    const workspace = workspacePackages(repo);
    const packageJobs = workspace.some((p) => /^packages\/[^/]+$/.test(p.dir));
    const packages = workspace.filter((p) => packageJobs ? /^packages\/[^/]+$/.test(p.dir) : !/^fixtures(?:\/|$)/.test(p.dir));
    if (packages.length > 0)
        return packages;
    if (workspace.length > 0 || !existsSync(join(repo, "package.json")))
        return [];
    const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    return [{ name: readPackage(repo, ".").name, dir: ".", manifest }];
}
/** Changed packages plus every transitive workspace dependent, like turbo's warm CI cache. */
export function ciAffectedPackages(repo, files) {
    const packages = ciPackages(repo);
    const changed = files.map((f) => f.replace(/^\.\//, ""));
    // CI skips markdown-only changes. Outside packages, only this small set of globally hashed root inputs fans out.
    if (changed.every((f) => /\.md$/.test(f)))
        return [];
    if (changed.some((f) => /^(?:package\.json|pnpm-lock\.yaml|turbo\.json|tsconfig[^/]*\.json)$/.test(f)))
        return packages;
    const dirs = new Set(groupByPackage(changed, packages.map((p) => p.dir)).keys());
    const workspace = workspacePackages(repo);
    const graph = workspace.length ? workspace : packages;
    const queue = graph.filter((p) => dirs.has(p.dir));
    for (let i = 0; i < queue.length; i++) {
        for (const dep of directDependents(graph, queue[i].name)) {
            if (dirs.has(dep.dir))
                continue;
            dirs.add(dep.dir);
            queue.push(dep);
        }
    }
    return packages.filter((p) => dirs.has(p.dir));
}
function ciEnv(repo) {
    return checkEnv(repo);
}
function ciConcurrency(env) {
    const workers = checkShare(env).vitest.find((f) => f.startsWith("--maxWorkers="));
    return Math.min(3, workers ? Number(workers.split("=")[1]) : 3);
}
function ciSuiteArgs(env) {
    // Split this check's vitest worker share across its concurrently running package suites, including retries.
    return ["--passWithNoTests", ...checkShare(env).vitest.map((arg) => `--maxWorkers=${Math.max(1, Math.floor(Number(arg.split("=")[1]) / ciConcurrency(env)))}`)];
}
function hasPackageTests(repo, pkg) {
    if (pkg.scripts?.["test:ci"] || pkg.scripts?.test || ["ts", "mts", "cts", "js", "mjs", "cjs"].some((ext) => existsSync(join(repo, pkg.dir, `vitest.config.${ext}`))))
        return true;
    const hasTests = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
                return true;
            if (entry.isDirectory() && !["node_modules", ".git", ".turbo", "dist", "coverage"].includes(entry.name) && hasTests(join(dir, entry.name)))
                return true;
        }
        return false;
    };
    return hasTests(join(repo, pkg.dir));
}
/** The default vitest reporter's file count, including an empty successful suite. */
function suiteFileCount(r) {
    const output = stripAnsi(`${r.stdout}\n${r.stderr}`);
    if (r.code === 0 && /No test files found/i.test(output))
        return 0;
    const summary = /^\s*Test Files\s+(.+)$/m.exec(output)?.[1];
    if (!summary || !/^\s*Tests\s+\d/m.test(output))
        return null;
    const total = /\((\d+)\)/.exec(summary);
    return total ? Number(total[1]) : [...summary.matchAll(/(\d+)\s+(?:passed|failed|skipped)/g)].reduce((n, m) => n + Number(m[1]), 0);
}
/** Build everything before any suite reads the outputs: cached builds must not restore files under running tests. */
async function ciBuild(repo, pkgs, env, opts) {
    if (detectToolchain(repo).turbo) {
        const names = pkgs.map((p) => p.name);
        const deps = await buildPackages(repo, names, opts.selfBuild ?? selfBuildOf(repo), env, pkgs);
        return deps.code === 0 ? buildSelf(repo, names, env) : deps;
    }
    const packages = workspacePackages(repo);
    const ordered = [];
    const visited = new Set();
    const visit = (pkg) => {
        if (visited.has(pkg.name))
            return;
        visited.add(pkg.name);
        for (const dep of packages)
            if (directDependents(packages, dep.name).some((p) => p.name === pkg.name))
                visit(readPackage(repo, dep.dir));
        ordered.push(pkg);
    };
    for (const pkg of pkgs)
        visit(pkg);
    for (const pkg of ordered) {
        if (!pkg.scripts?.build)
            continue;
        const r = await exec(detectToolchain(repo).pm, ["run", "build"], { cwd: join(repo, pkg.dir), env });
        if (r.code !== 0)
            return r;
    }
    return { code: 0, stdout: "", stderr: "" };
}
/** Full-suite failures at HEAD, once per base; coverage maps already carry the same quarantine data. */
export async function recordCiBase(repo, dirs, log, given = {}) {
    const opts = resolveOptions(repo, given);
    const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    if (dirty)
        throw new Error("ci-base requires tracked files to match HEAD; commit or stash changes first");
    const packages = ciPackages(repo);
    for (const dir of dirs)
        if (!packages.some((p) => p.dir === dir))
            throw new Error(`not a CI package directory: ${dir}`);
    const selected = dirs.length ? ciAffectedPackages(repo, dirs.map((dir) => inPackage(dir, "package.json"))) : packages;
    const pending = selected.filter((p) => {
        if (!readTiaMap(base, p.dir, opts.recordsDir) && !readCiBase(base, p.dir, opts.recordsDir))
            return true;
        log(`${p.name}: full-suite base already recorded at ${base.slice(0, 12)}`);
        return false;
    }).map((p) => readPackage(repo, p.dir));
    if (pending.length === 0)
        return 0;
    const env = ciEnv(repo);
    log(`building ${pending.length} CI package(s) and dependencies for the base suites`);
    const built = await ciBuild(repo, pending, env, opts);
    if (built.code !== 0) {
        log(`base build failed:\n${failureOutput(built)}`);
        return built.code;
    }
    await limited(pending.map((pkg) => async () => {
        log(`${pkg.name}: recording its full suite at ${base.slice(0, 12)}`);
        const r = hasPackageTests(repo, pkg) ? await vitestInPackage(repo, pkg, "run", [], ciSuiteArgs(env), env) : { code: 0, stdout: "No test files found", stderr: "" };
        const count = suiteFileCount(r);
        const record = { base, packageDir: pkg.dir, baseFailures: suiteFailures(r), testFiles: count ?? 0, ...(count === null ? { unavailable: `suite could not run on the base (exit ${r.code}, no test summary)` } : {}) };
        log(`${pkg.name}: ${record.unavailable ?? `${record.baseFailures.length} base failure(s), ${record.testFiles} test files`} recorded in ${writeCiBase(record, opts.recordsDir)}`);
    }), ciConcurrency(env));
    return 0;
}
/** Merge-group CI: no coverage selection, declaration narrowing or verdict reuse; only base failures are reused. */
export async function checkCiFiles(repo, files, log, given = {}) {
    const opts = resolveOptions(repo, given);
    const pkgs = ciAffectedPackages(repo, files).map((p) => readPackage(repo, p.dir));
    if (pkgs.length === 0) {
        log("no CI package inputs changed; nothing to test");
        return 0;
    }
    const env = ciEnv(repo);
    const base = baseFor(repo, opts);
    const started = Date.now();
    log(`CI: building ${pkgs.length} affected package(s) and their dependencies`);
    const built = await ciBuild(repo, pkgs, env, opts);
    const buildNote = `built with dependencies in ${Math.round((Date.now() - started) / 1000)} s`;
    if (built.code !== 0) {
        log(`build failed:\n${failureOutput(built)}`);
        for (const pkg of pkgs)
            log(`summary: ${pkg.name}: ${buildNote}; build failed`);
        return built.code;
    }
    const results = await limited(pkgs.map((pkg) => async () => {
        const t = Date.now();
        const types = detectToolchain(repo).turbo ? await typeCheckFilters(repo, [`--filter=${pkg.name}`], env) : await typeCheckPlain(repo, pkg, env);
        const steps = [buildNote, types.skipped ? "no type check" : `type check ${types.code === 0 ? "passed" : "failed"} in ${Math.round((Date.now() - t) / 1000)} s`];
        if (types.code !== 0)
            log(`type check failed for ${pkg.name}:\n${failureOutput(types)}`);
        const map = readTiaMap(base, pkg.dir, opts.recordsDir);
        const record = readCiBase(base, pkg.dir, opts.recordsDir);
        let code = types.code;
        if (record?.unavailable && !map) {
            log(`${pkg.name}: tests skipped; ${record.unavailable} (real GitHub CI has a green base)`);
            steps.push("full suite skipped (unavailable on base)");
        }
        else if (!hasPackageTests(repo, pkg))
            steps.push("no tests");
        else {
            log(`CI: full suite of ${pkg.name}`);
            const t = Date.now();
            // workers-sdk's test:ci ultimately invokes vitest run. The helper preserves node options and check-slot
            // limits, bypassing the dotenv/git-version wrappers, while running every test file without TIA.
            const first = await vitestInPackage(repo, pkg, "run", [], ciSuiteArgs(env), env);
            const r = await secondChance(repo, pkg, first, env, log, map?.baseFailures ?? record?.baseFailures ?? [], ciSuiteArgs(env));
            process.stdout.write(r.stdout);
            process.stderr.write(r.stderr);
            steps.push(`full suite ${r.code === 0 ? "passed" : "failed"} in ${Math.round((Date.now() - t) / 1000)} s (${suiteFileCount(first) ?? "unknown"} test files)${r.note ? ` (${r.note})` : ""}`);
            code = Math.max(code, r.code);
        }
        return { code, summary: `${pkg.name}: ${steps.join(", ")}` };
    }), ciConcurrency(env));
    for (const r of results)
        log(`summary: ${r.summary}`);
    return Math.max(0, ...results.map((r) => r.code));
}
/** The benchmark's check command; product CLI options are handled in cli.ts. */
export async function main(argv) {
    const repo = process.cwd();
    const log = (l) => console.error(`[check] ${l}`);
    const [mode, ...files] = argv;
    if (mode === "related")
        return checkFiles(repo, files, log);
    if (mode === "ci")
        return checkCiFiles(repo, files, log);
    if (mode === "ci-base")
        return recordCiBase(repo, files, log);
    if (mode === "since-base")
        return checkFiles(repo, await changedSinceBase(repo), log);
    console.error("usage: check.js related <files...> | ci <files...> | ci-base [package dirs...] | since-base");
    return 2;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=check.js.map