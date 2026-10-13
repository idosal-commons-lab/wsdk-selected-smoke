// Recording a base for the verification planner (`commons check map`): at a commit, build the packages, record their
// declaration surfaces (surface.ts, dependents.ts) and run each package's suite once under function instrumentation
// to record which test file executed which function (tia.ts). Records are keyed by the commit and found again as the
// nearest recorded ancestor of whatever is checked later (records.ts).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { declarationHashes, declarationIndex, workspacePackages } from "./dependents.js";
import { readTiaMap, verifyDir, writeBaseSurfaces, writeTiaMap } from "./records.js";
import { checkEnv, readProfile, recordsDirOf } from "./profile.js";
import { declarationSurface } from "./surface.js";
import { buildTiaMap, bundlesOf, restoreBundles } from "./tia.js";
import { buildPackages, buildSelf, detectToolchain, readPackage, typeCheckFilters, vitestInPackage } from "./workspace.js";
import { packageDirs, selfBuildOf } from "./check.js";
import { buildPythonMap, isPythonPackage } from "./python.js";
/** The module the instrumenting vitest config imports: the built one, else the source (run through tsx or vite). */
export function tiaModulePath() {
    const js = fileURLToPath(new URL("./tia.js", import.meta.url));
    return existsSync(js) ? js : fileURLToPath(new URL("./tia.ts", import.meta.url));
}
/** Record the declaration surfaces of built packages at `base`. */
export function recordSurfaces(repo, base, pkgs, recordsDir = verifyDir()) {
    const surfaces = Object.fromEntries(pkgs.map((p) => {
        const hash = declarationSurface(join(repo, p.dir));
        const index = hash ? declarationIndex(join(repo, p.dir)) : null;
        return [p.name, hash ? { hash, ...(index ? { decls: declarationHashes(index) } : {}) } : null];
    }));
    return { path: writeBaseSurfaces(base, surfaces, recordsDir), surfaces };
}
/**
 * The built bundles a package's coverage run instruments: its own (tests that import the package by name run its
 * dist) and those of the workspace packages it depends on (tests run their code through their dist), so the map also
 * records which of their functions this package's tests execute (cross-package selection, selectDependentTests).
 */
export function coverageBundles(repo, pkg) {
    const packages = workspacePackages(repo);
    const self = packages.find((p) => p.dir === pkg.dir);
    const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const deps = new Set();
    for (const f of fields) {
        const block = self?.manifest[f];
        if (block && typeof block === "object")
            for (const name of Object.keys(block))
                deps.add(name);
    }
    const dirs = [pkg.dir, ...packages.filter((p) => deps.has(p.name)).map((p) => p.dir)];
    for (const dir of dirs)
        restoreBundles(join(repo, dir));
    return dirs.flatMap((dir) => bundlesOf(join(repo, dir)));
}
/** Run a package's suite once under instrumentation and record its function-coverage map at `base`. */
export async function recordCoverage(o) {
    const map = isPythonPackage(o.repo, o.pkg.dir) ? await buildPythonMap({ repo: o.repo, root: o.base, packageDir: o.pkg.dir, log: o.log }) : await buildTiaMap({
        ...(o.bundles !== false ? { bundles: coverageBundles(o.repo, o.pkg) } : {}),
        repo: o.repo,
        root: o.base,
        packageDir: o.pkg.dir,
        tiaModule: tiaModulePath(),
        workDir: o.workDir,
        runVitest: (args, extra) => vitestInPackage(o.repo, o.pkg, "run", [], args, { ...o.env, ...extra }),
        log: o.log,
    });
    if (map)
        o.log?.(`coverage map of ${o.pkg.name} recorded in ${writeTiaMap(map, o.recordsDir)}`);
    return map;
}
/**
 * Record the base at HEAD for `packages` (directories; default: Python projects and packages with a vitest config). The working tree
 * must match HEAD for tracked files, since the records describe the commit.
 */
export async function mapBase(o) {
    const recordsDir = o.recordsDir ?? recordsDirOf(o.repo);
    const base = execFileSync("git", ["-C", o.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", o.repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    if (dirty && !o.force)
        throw new Error(`the working tree has uncommitted changes; the records would not describe ${base.slice(0, 12)} (commit or stash them, or pass --force)`);
    const all = packageDirs(o.repo, workspacePackages(o.repo));
    const hasVitest = (dir) => ["vitest.config.mts", "vitest.config.ts", "vitest.config.mjs", "vitest.config.js"].some((f) => existsSync(join(o.repo, dir, f)));
    const dirs = o.packages?.length ? o.packages : (readProfile(o.repo).coverage ?? all.filter((dir) => hasVitest(dir) || isPythonPackage(o.repo, dir)));
    const pkgs = dirs.map((d) => readPackage(o.repo, d));
    const jsPkgs = pkgs.filter((p) => !isPythonPackage(o.repo, p.dir));
    const toolchain = detectToolchain(o.repo);
    const env = checkEnv(o.repo);
    let surfaces = 0;
    if (toolchain.turbo && jsPkgs.length > 0) {
        o.log(`building ${jsPkgs.length} package(s) and their dependencies`);
        const names = jsPkgs.map((p) => p.name);
        const deps = await buildPackages(o.repo, names, o.selfBuild ?? selfBuildOf(o.repo), env, jsPkgs);
        const self = deps.code === 0 ? await buildSelf(o.repo, names, env) : deps;
        if (self.code === 0) {
            const r = recordSurfaces(o.repo, base, jsPkgs, recordsDir);
            surfaces = Object.values(r.surfaces).filter(Boolean).length;
            o.log(`declaration surfaces of ${surfaces}/${jsPkgs.length} package(s) recorded in ${r.path}`);
        }
        else
            o.log(`build failed; no declaration surfaces recorded (dependents will always be type-checked): ${self.stderr.slice(-800)}`);
    }
    if (toolchain.turbo && pkgs.length > 0 && o.typeState !== false) {
        // Incremental type state: run each package's type check once for real (not replayed from turbo's cache), so its
        // tsc build info sits in the base. Checkouts cloned from it, and work clones that keep their untracked files
        // across checkouts, then type-check only what changed and what depends on it.
        const started = Date.now();
        const r = await typeCheckFilters(o.repo, pkgs.map((p) => `--filter=${p.name}`), env, { force: true });
        o.log(`type state: ${r.code === 0 ? "recorded" : `type check exited ${r.code}`} for ${pkgs.length} package(s) in ${Math.round((Date.now() - started) / 1000)} s`);
    }
    const maps = [];
    const skipped = [];
    for (const pkg of pkgs) {
        if (readTiaMap(base, pkg.dir, recordsDir)) {
            maps.push(pkg.dir);
            o.log(`${pkg.name}: coverage map already recorded at ${base.slice(0, 12)}`);
            continue;
        }
        if (!hasVitest(pkg.dir) && !isPythonPackage(o.repo, pkg.dir)) {
            skipped.push(pkg.dir);
            continue;
        }
        o.log(`${pkg.name}: running its suite once under function instrumentation`);
        const map = await recordCoverage({ repo: o.repo, base, pkg, env, workDir: join(recordsDir, "tia", base, `${pkg.dir.replace(/[/\\]/g, "__") || "__root"}.work`), recordsDir, log: o.log });
        if (map)
            maps.push(pkg.dir);
        else
            skipped.push(pkg.dir);
    }
    return { base, surfaces, maps, skipped };
}
//# sourceMappingURL=map.js.map