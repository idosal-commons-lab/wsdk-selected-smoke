import { homedir } from "node:os";
// Prepare the issues workload: a partial clone of the repository for reference, a self-contained base repository
// (one orphan commit of the tree at the window's base, so the real fixes are not in any history the agents see),
// installed dependencies in a shared pnpm store, a shared turbo cache, hidden tests on disk, and runner tasks.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { git } from "../../executor/git.js";
import { excludePaths } from "../../runner/worktrees.js";
import { taskBodyFor } from "./collect.js";
import { selfBuildOf } from "./check.js";
import { ciAffectedPackages, recordCiBase } from "../../verify/check.js";
import { buildPackages, buildSelf, detectToolchain, exec, monorepoEnv, pnpmArgs, readPackage, vitestInPackage } from "../../verify/workspace.js";
import { adapt, writeCalibration } from "../../verify/adapt.js";
import { mapBase } from "../../verify/map.js";
import { closureIndex } from "../../executor/footprint.js";
import { buildTiaMap, readTiaMap, writeTiaMap } from "../../verify/tia.js";
import { declarationSurface, writeBaseSurfaces } from "../../verify/surface.js";
import { declarationHashes, declarationIndex } from "../../verify/dependents.js";
const ROOT = resolve(new URL("../../..", import.meta.url).pathname); // platform/
export function runnerTasks(set) {
    return set.tasks.map((t) => ({
        id: t.id,
        title: t.issue.title,
        body: taskBodyFor(t),
        writes: [{ path: `${t.package}/src` }],
        reads: [{ path: `${t.package}/package.json` }],
    }));
}
/**
 * What the base copy keeps: everything but the source's own `.git` directory and installed dependencies. The first
 * version tested `src.includes(sourceDir + "/.git")`, which also dropped the root `.gitignore`, `.github/` and
 * `.gitattributes`: every generated file became committable (test reports, build outputs) and `@cloudflare/tools`,
 * which imports from `.github/`, failed to type-check on the base.
 */
export function baseCopyFilter(sourceDir) {
    return (src) => {
        const rel = relative(sourceDir, src);
        if (rel === ".git" || rel.startsWith(`.git${sep}`))
            return false;
        return !rel.split(sep).includes("node_modules");
    };
}
/** Bumped whenever the base copy changes; a prepared base of another format is rebuilt. */
export const BASE_FORMAT = 2;
function baseFormatOf(repoDir) {
    try {
        const m = /^format: (\d+)$/m.exec(readFileSync(join(repoDir, ".issues-ready"), "utf8"));
        return m ? Number(m[1]) : 1;
    }
    catch {
        return 0;
    }
}
export async function prepareIssues(o) {
    const log = o.log ?? ((line) => console.error(`[issues] ${line}`));
    const set = JSON.parse(await readFile(o.setPath, "utf8"));
    const [owner, name] = set.repo.split("/");
    const tmp = benchRoot("issues");
    await mkdir(tmp, { recursive: true });
    const sourceDir = join(tmp, name);
    const repoDir = join(tmp, `${name}-base-${set.baseCommit.slice(0, 12)}`);
    const hiddenDir = join(tmp, `${name}-hidden-${set.baseCommit.slice(0, 12)}`);
    const storeDir = join(tmp, "pnpm-store");
    const turboCacheDir = join(tmp, "turbo-cache");
    // The workload's project profile (what `commons adapt` would have committed to the repository), beside the set:
    // bench/issues/<repo>.profile.json. Records stay in the workload directory, shared by every checkout of the base.
    const profile = o.setPath.replace(/\.json$/, ".profile.json");
    const env = { ...monorepoEnv(turboCacheDir, storeDir), COMMONS_VERIFY_DIR: tmp, COMMONS_PROFILE: profile };
    // Set here too: the checks and the adaptation below run in this process.
    for (const key of ["COMMONS_VERIFY_DIR", "COMMONS_PROFILE"])
        process.env[key] = env[key];
    if (!existsSync(join(sourceDir, ".git"))) {
        log(`partial clone of ${set.repo}`);
        const r = await exec("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `https://github.com/${owner}/${name}.git`, sourceDir], { cwd: tmp });
        if (r.code !== 0)
            throw new Error(`clone failed: ${r.stderr}`);
    }
    try {
        await git(sourceDir, ["cat-file", "-e", `${set.baseCommit}^{commit}`]);
    }
    catch {
        await git(sourceDir, ["fetch", "-q", "origin", set.baseCommit]);
    }
    const head = await git(sourceDir, ["rev-parse", "HEAD"]).catch(() => "");
    if (head !== set.baseCommit)
        await git(sourceDir, ["checkout", "-q", "--detach", set.baseCommit]);
    if (baseFormatOf(repoDir) !== BASE_FORMAT) {
        await rm(repoDir, { recursive: true, force: true });
        log(`building base repository from ${set.baseCommit.slice(0, 12)}`);
        await mkdir(repoDir, { recursive: true });
        await cp(sourceDir, repoDir, { recursive: true, filter: baseCopyFilter(sourceDir) });
        await git(repoDir, ["init", "-q", "-b", "main"]);
        await git(repoDir, ["add", "-A"]);
        await git(repoDir, ["-c", "user.name=Commons Bench", "-c", "user.email=bench@commons.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `issues: ${set.repo} at ${set.baseCommit.slice(0, 12)} (${set.windowStart.slice(0, 10)} .. ${set.windowEnd.slice(0, 10)})`]);
        await mkdir(hiddenDir, { recursive: true });
        for (const t of set.tasks) {
            for (const f of t.testFiles) {
                const p = join(hiddenDir, t.id, f.path);
                await mkdir(dirname(p), { recursive: true });
                await writeFile(p, f.content);
            }
        }
        await writeFile(join(repoDir, ".issues-ready"), `format: ${BASE_FORMAT}\n${set.tasks.map((t) => t.id).join("\n")}\n`);
    }
    const pnpm = pnpmArgs(repoDir, ["install", "--frozen-lockfile", "--prefer-offline"]);
    if (!existsSync(join(repoDir, "node_modules", ".pnpm"))) {
        log("installing dependencies in the base (this fills the shared store)");
        const r = await exec(pnpm.cmd, pnpm.args, { cwd: repoDir, env });
        if (r.code !== 0)
            throw new Error(`pnpm install failed: ${r.stderr.slice(-3000)}`);
    }
    if (o.build !== false && !existsSync(profile)) {
        // No profile for this workload yet: install Commons on the base the way a user would, and keep what it learned
        // beside the set (bench/issues/<repo>.profile.json) for review.
        log(`adapting Commons to ${set.repo} (no ${profile} yet)`);
        const r = await adapt(repoDir, { ai: true, validate: true, log: (l) => log(`adapt: ${l}`) });
        log(`profile written to ${r.path}${r.costUsd ? ` (review $${r.costUsd.toFixed(2)})` : ""}; validation ${r.validation ? (r.validation.ok ? "passed" : "FAILED") : "skipped"}`);
        env.COMMONS_PROFILE = profile;
        process.env.COMMONS_PROFILE = profile;
    }
    if (o.build !== false && !detectToolchain(repoDir).turbo) {
        // Without turbo there is no shared build cache to fill: record the base the product's way (the profile's coverage
        // units, their base failures), once per base.
        const m = await mapBase({ repo: repoDir, log });
        log(`base ${m.base.slice(0, 12)}: ${m.maps.length} coverage map(s)${m.skipped.length ? `; no map for ${m.skipped.join(", ")}` : ""}`);
        writeCalibration(repoDir, tmp, m.base, (l) => log(`calibrate: ${l}`));
    }
    else if (o.build !== false) {
        const names = [...new Set(set.tasks.map((t) => readPackage(repoDir, t.package).name))];
        log(`building ${names.length} packages and their dependencies into the shared turbo cache`);
        const pkgs = set.tasks.map((t) => readPackage(repoDir, t.package));
        const r = await buildPackages(repoDir, names, selfBuildOf(repoDir), env, pkgs);
        if (r.code !== 0)
            throw new Error(`turbo build failed: ${r.stderr.slice(-3000)}`);
        // The base's declaration surfaces, which the check compares a change's against to decide whether dependents
        // must be type-checked (verify/surface.ts).
        const self = await buildSelf(repoDir, names, env);
        if (self.code === 0) {
            const rootCommit = await git(repoDir, ["rev-parse", "HEAD"]);
            const surfaces = Object.fromEntries(pkgs.map((p) => {
                const hash = declarationSurface(join(repoDir, p.dir));
                const index = hash ? declarationIndex(join(repoDir, p.dir)) : null;
                return [p.name, hash ? { hash, ...(index ? { decls: declarationHashes(index) } : {}) } : null];
            }));
            const path = writeBaseSurfaces(rootCommit, surfaces);
            log(`declaration surfaces of ${Object.values(surfaces).filter(Boolean).length}/${Object.keys(surfaces).length} packages recorded in ${path}`);
        }
        else
            log(`building the task packages failed; dependents are always type-checked: ${self.stderr.slice(-500)}`);
        // Function-coverage maps for the packages whose related tests are the whole suite (verify/tia.ts), once per base.
        const rootCommit = await git(repoDir, ["rev-parse", "HEAD"]);
        const tiaPackages = (process.env.COMMONS_TIA_PACKAGES ?? "packages/wrangler").split(",").map((p) => p.trim()).filter(Boolean);
        for (const dir of tiaPackages) {
            if (!set.tasks.some((t) => t.package === dir) || readTiaMap(rootCommit, dir))
                continue;
            const pkg = readPackage(repoDir, dir);
            log(`building the function-coverage map of ${pkg.name} (its whole suite, once per base)`);
            const map = await buildTiaMap({
                repo: repoDir,
                root: rootCommit,
                packageDir: dir,
                tiaModule: existsSync(join(ROOT, "dist", "verify", "tia.js")) ? join(ROOT, "dist", "verify", "tia.js") : join(ROOT, "src", "verify", "tia.ts"),
                workDir: join(tmp, "tia", rootCommit, `${dir.replace(/[/\\]/g, "__")}.work`),
                runVitest: (args, extra) => vitestInPackage(repoDir, pkg, "run", [], args, { ...env, ...extra }),
                log,
            });
            if (map)
                log(`coverage map recorded in ${writeTiaMap(map)}`);
        }
        if (o.ciBase) {
            const dirs = ciAffectedPackages(repoDir, set.tasks.map((t) => `${t.package}/src/index.ts`)).map((p) => p.dir);
            const code = await recordCiBase(repoDir, dirs, log);
            if (code !== 0)
                throw new Error(`CI base preparation failed (exit ${code})`);
        }
    }
    // One index of the base fills the machine-wide parse cache, so no agent's first submit parses the repository.
    const indexed = Date.now();
    const index = closureIndex(repoDir);
    log(`indexed ${index.files} source files of the base in ${Math.round((Date.now() - indexed) / 1000)} s`);
    const checkJs = join(ROOT, "dist", "bench", "issues", "check.js");
    // Everything the install and the build left untracked in the base (dist, dist-types, .turbo, generated schemas,
    // playground outputs, nested node_modules) is excluded in every checkout, whatever it is called: an agent's
    // `git add -A` must commit its fix, not the build.
    const generated = generatedPaths(await exec("git", ["status", "--porcelain", "-z", "--untracked-files=normal"], { cwd: repoDir }).then((r) => r.stdout));
    const prepareCheckout = async (dir) => {
        // A copy-on-write clone of the base arrives installed; a fresh clone gets the offline install.
        if (!existsSync(join(dir, "node_modules", ".pnpm"))) {
            const i = pnpmArgs(dir, ["install", "--frozen-lockfile", "--offline"]);
            const r = await exec(i.cmd, i.args, { cwd: dir, env });
            if (r.code !== 0)
                throw new Error(`offline install failed in ${dir}: ${r.stderr.slice(-2000)}`);
        }
        // turbo restores build outputs into the checkout and the repository does not ignore all of them; an agent's
        // `git add -A` must never sweep them (or the preparation marker) into a submission.
        excludePaths(dir, ["dist/", "**/dist/", ".turbo/", "**/.turbo/", "**/*.tsbuildinfo", ".issues-ready", ...generated]);
    };
    return {
        set,
        repoDir,
        sourceDir,
        hiddenDir,
        storeDir,
        turboCacheDir,
        env,
        tasks: runnerTasks(set),
        testCommand: `node ${checkJs} since-base`,
        relatedCommand: `node ${checkJs} related {files}`,
        ciCommand: `node ${checkJs} ci {files}`,
        prepareCheckout,
    };
}
/** Anchored exclude patterns for the untracked entries of a `git status --porcelain -z --untracked-files=normal` listing (NUL-separated, never quoted). */
export function generatedPaths(status) {
    const out = [];
    const entries = status.split("\0");
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 4)
            continue;
        const code = entry.slice(0, 2);
        const path = entry.slice(3);
        if ((code[0] === "R" || code[0] === "C") && i + 1 < entries.length)
            i++; // a rename carries its source as the next field
        if (code === "??" && path.length > 0)
            out.push(`/${path}`);
    }
    return out;
}
/**
 * Where benchmark checkouts live. A checkout under this platform's tree resolves packages its pnpm layout does not
 * expose (a transitive `@vitest/spy`, say) from the platform's own node_modules two directories up, which is how
 * `FinalizationRegistry is not defined` reached the first runs; so the default is outside any node_modules
 * ancestor, overridable with COMMONS_BENCH_ROOT.
 */
export function benchRoot(...segments) {
    const root = process.env.COMMONS_BENCH_ROOT ?? join(homedir(), ".commons-bench");
    return join(root, ...segments);
}
//# sourceMappingURL=prepare.js.map