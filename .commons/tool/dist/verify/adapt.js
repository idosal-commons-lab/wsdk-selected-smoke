// Installing Commons on a repository (`commons adapt`): find out how this project builds, type-checks and tests, and
// write what was learned to its project profile (.commons/project.json, see profile.ts). Three steps:
//
//   1. Discover: the workspace and toolchain, every package's scripts and test runner config, the root's, and what the
//      CI workflows run. A draft profile follows from rules (one root vitest config and none per package: the root
//      layout; a root script that runs `vitest --project unit`: those arguments).
//   2. Review (--ai): a model reads the facts and the draft, may read the repository itself (read-only tools), and
//      returns the profile with a note per decision: a build command that produces what tests need and skips a slow or
//      brittle step, vitest projects that need a browser or network left out, an incremental type check.
//   3. Validate: plan a check of the last code commit, then run it on the commit (main is green, so it must pass). A
//      failure goes back to the model once with the output, and the corrected profile is validated again.
//
// The point is that there is no one configuration that fits every repository, and nobody has to write this one by hand.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { checkFiles, mapsAt, planCheck, formatPlan } from "./check.js";
import { directDependents, workspacePackages } from "./dependents.js";
import { readProfile, writeProfile } from "./profile.js";
import { detectToolchain, readPackage } from "./workspace.js";
const run = promisify(execFile);
const VITEST_CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs", "vitest.workspace.ts", "vitest.workspace.js"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", ".turbo", "coverage", ".next", ".wrangler", "out"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const RELEVANT_SCRIPT = /^(build|test|test[:-].*|check|check[:-].*|typecheck|type-check|lint)$/;
function vitestConfigIn(dir) {
    return VITEST_CONFIGS.find((f) => existsSync(join(dir, f))) ?? null;
}
/** Test files under `dir` (outside dependencies and build outputs), counted up to `cap`. */
function countTests(dir, cap = 2000, skipDirs = new Set()) {
    let n = 0;
    const walk = (d, depth) => {
        if (n >= cap || depth > 8)
            return;
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (n >= cap)
                return;
            if (e.isDirectory()) {
                if (!SKIP.has(e.name) && !e.name.startsWith(".") && !skipDirs.has(join(d, e.name)))
                    walk(join(d, e.name), depth + 1);
            }
            else if (TEST_FILE.test(e.name))
                n++;
        }
    };
    walk(dir, 0);
    return n;
}
function relevantScripts(scripts) {
    return Object.fromEntries(Object.entries(scripts).filter(([k]) => RELEVANT_SCRIPT.test(k)));
}
function ciRuns(repo) {
    const dir = join(repo, ".github", "workflows");
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
        const text = readFileSync(join(dir, file), "utf8");
        const runs = [...text.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1].trim()).filter((r) => /test|check|build|type|lint|vitest|jest|tsc/.test(r));
        if (runs.length > 0)
            out.push({ file, runs: runs.slice(0, 12) });
    }
    return out;
}
/** What the repository looks like to a check. */
export function discover(repo) {
    const packages = workspacePackages(repo).map((p) => {
        const info = readPackage(repo, p.dir);
        return { dir: p.dir, name: info.name, scripts: relevantScripts(info.scripts ?? {}), vitestConfig: vitestConfigIn(join(repo, p.dir)), testFiles: countTests(join(repo, p.dir)) };
    });
    const rootInfo = readPackage(repo, ".");
    const packageDirs = new Set(packages.map((p) => join(repo, p.dir)));
    return {
        toolchain: detectToolchain(repo),
        root: { scripts: relevantScripts(rootInfo.scripts ?? {}), vitestConfig: vitestConfigIn(repo), testFiles: countTests(repo, 2000, packageDirs) },
        packages,
        ci: ciRuns(repo),
    };
}
/** The profile the facts imply by rule, with a note per decision. */
export function draftProfile(facts) {
    const notes = [];
    const withOwnConfig = facts.packages.filter((p) => p.vitestConfig);
    const packageTests = facts.packages.reduce((n, p) => n + p.testFiles, 0);
    let layout = "packages";
    if (facts.root.vitestConfig && withOwnConfig.length === 0 && (packageTests > 0 || facts.root.testFiles > 0)) {
        layout = "root";
        notes.push(`one vitest config at the root (${facts.root.vitestConfig}) and none in the ${facts.packages.length} packages: the repository is checked as one unit`);
    }
    else if (withOwnConfig.length > 0)
        notes.push(`${withOwnConfig.length} of ${facts.packages.length} packages have their own vitest config: each is checked by itself`);
    const profile = { version: 1, layout };
    if (layout === "root") {
        // A root script that runs a subset of vitest projects names the unit tests (the rest need browsers or a build).
        for (const [name, script] of Object.entries(facts.root.scripts)) {
            const m = /\bvitest\b.*?--project[ =](\S+)/.exec(script);
            if (m && /unit/.test(name)) {
                profile.vitestArgs = ["--project", m[1].replace(/^['"]|['"]$/g, "")];
                notes.push(`vitest runs the projects the \`${name}\` script runs (${profile.vitestArgs.join(" ")})`);
                break;
            }
        }
        profile.coverage = ["."];
    }
    else {
        profile.coverage = withOwnConfig.filter((p) => p.testFiles > 0).map((p) => p.dir);
    }
    profile.notes = notes;
    return profile;
}
const ProfileSchema = z.object({
    version: z.literal(1).optional(),
    layout: z.enum(["packages", "root"]).optional(),
    vitestArgs: z.array(z.string()).optional(),
    packages: z.record(z.string(), z.object({ build: z.array(z.string()).nullable().optional(), typecheck: z.array(z.string()).nullable().optional() })).optional(),
    env: z.record(z.string(), z.string()).optional(),
    records: z.string().optional(),
    coverage: z.array(z.string()).optional(),
    limits: z.object({ maxRisk: z.number().int().min(0).optional(), maxDependentTests: z.number().int().positive().optional(), maxLane: z.number().int().positive().optional() }).optional(),
    notes: z.array(z.string()).optional(),
});
const REVIEW = (facts, draft, failure) => `You are configuring Commons, a merge queue that checks every change to this repository by building what the change needs, type-checking it and running the tests that cover it. Commons is being installed on this repository (your working directory). It found the facts below and drafted a project profile. Your job: return the profile that makes checks of THIS repository correct and fast.

The profile (.commons/project.json) has these fields, all optional:
- layout: "packages" (each workspace package runs its own tests with its own vitest config) or "root" (one vitest config at the root covers every package; the repository is checked as one unit ".").
- vitestArgs: arguments added to every vitest run, e.g. ["--project", "unit"] to leave out projects that need a browser, a network, or a full build.
- packages: per package directory ("." for the root), { build: command array that builds what the package's tests and its dependents need, replacing its "build" script, or null when NOTHING needs building at all (tests and dependents read sources); typecheck: command array, or null for no type check at all }. To keep a package's defaults (its own "build" script; its "check:type"/"typecheck"/"type-check" script, else tsc --noEmit), leave the package out entirely: null never means "default". Only add an override when the default is wrong or much slower than needed for a check, e.g. a build that also bundles type declarations and fails on errors in test files (but keep declarations when dependents type-check against them).
- env: environment variables the tests need.
- coverage: package directories whose tests Commons runs once at the base under instrumentation, to map tests to the functions they execute (use ["."] for the root layout).
- limits: leave out unless you have a reason.
- notes: one short sentence per decision, saying what you saw in the repository that justifies it.

Read whatever you need (package.json files, vitest configs, build scripts, CI workflows) before deciding. Do not modify any file.

Facts:
${JSON.stringify(facts, null, 2)}

Draft:
${JSON.stringify(draft, null, 2)}
${failure ? `\nThe draft failed validation: a check of the last commit on main (which passes CI) failed with this output. Fix the profile so the check succeeds for the right reason (do not hide real tests):\n${failure}\n` : ""}
Reply with the complete profile as one JSON object in a \`\`\`json code block, and nothing after it.`;
/**
 * Guardrails on a reviewed profile: a package that other workspace packages depend on keeps its build unless the model
 * gave a command (null there would leave dependents without its output; a model has written null meaning "default").
 */
export function guard(repo, profile, facts) {
    const notes = [...(profile.notes ?? [])];
    const packages = { ...(profile.packages ?? {}) };
    const names = new Map(facts.packages.map((p) => [p.dir, p.name]));
    const all = workspacePackages(repo);
    for (const [dir, entry] of Object.entries(packages)) {
        if (entry.build !== null || dir === ".")
            continue;
        const name = names.get(dir);
        const dependents = name ? directDependents(all, name) : [];
        if (dependents.length === 0)
            continue;
        const { build: _dropped, ...rest } = entry;
        if (Object.keys(rest).length === 0)
            delete packages[dir];
        else
            packages[dir] = rest;
        notes.push(`${dir}: kept its default build (${dependents.length} package(s) depend on it; the review had set none)`);
    }
    return { ...profile, packages, notes };
}
/** Ask a model to review the draft, letting it read the repository; null when no usable profile came back. */
export async function reviewProfile(repo, facts, draft, opts = {}) {
    const prompt = REVIEW(facts, draft, opts.failure);
    let stdout;
    try {
        const r = await run("claude", 
        // Not --bare: on macOS that mode skips the keychain credentials. Read-only tools, no MCP servers, no user settings.
        ["-p", prompt, "--max-turns", "30", "--output-format", "json", "--model", opts.model ?? "sonnet", "--strict-mcp-config", "--setting-sources", "project", "--allowedTools", "Read,Grep,Glob", "--permission-mode", "dontAsk"], { cwd: repo, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 15 * 60 * 1000, env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } });
        stdout = r.stdout;
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string")
            stdout = error.stdout;
        else
            return null;
    }
    let text = "";
    let costUsd = 0;
    try {
        const out = JSON.parse(stdout);
        text = out.result ?? "";
        costUsd = out.total_cost_usd ?? 0;
    }
    catch {
        text = stdout;
    }
    const block = /```json\s*([\s\S]*?)```/.exec(text)?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
        const parsed = ProfileSchema.parse(JSON.parse(block));
        return { profile: { ...parsed, version: 1 }, costUsd, raw: text };
    }
    catch {
        return null;
    }
}
/** The files of the most recent commit that changed code (not the root commit), and that commit. */
function lastCodeCommit(repo) {
    const log = execFileSync("git", ["-C", repo, "log", "-n", "30", "--format=%H %P", "--no-merges"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const line of log) {
        const [commit, parent] = line.split(" ");
        if (!commit || !parent)
            continue;
        const files = execFileSync("git", ["-C", repo, "diff-tree", "--no-commit-id", "--name-only", "-r", commit], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
        if (files.some((f) => /\.[cm]?[jt]sx?$|\.py$/.test(f) && !TEST_FILE.test(f)))
            return { commit, files };
    }
    return null;
}
/** One tracked test file per coverage unit of the profile (or per package with tests). */
function sampleTests(repo) {
    const tracked = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n").filter((f) => TEST_FILE.test(f) && !f.includes("node_modules/"));
    const units = readProfile(repo).coverage ?? ["."];
    const files = units.map((u) => tracked.find((f) => u === "." || f.startsWith(`${u}/`))).filter((f) => !!f);
    if (files.length === 0)
        return null;
    return { commit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), files };
}
/**
 * Plan and run a check of the last code commit's files at HEAD (that commit must be HEAD or an ancestor that is
 * green). The profile under validation is the one on disk (or COMMONS_PROFILE).
 */
export async function validateProfile(repo, log) {
    // Without history to check (a single-commit checkout), one existing test of every unit: its runner, arguments and
    // type check must work, and the base must pass it.
    const last = lastCodeCommit(repo) ?? sampleTests(repo);
    if (!last)
        return { ok: true, output: "no code commit in the last 30 and no test file to validate with" };
    const plan = formatPlan(await planCheck(repo, last.files));
    const lines = [];
    const code = await checkFiles(repo, last.files, (l) => {
        lines.push(l);
        log(l);
    });
    return { ok: code === 0, commit: last.commit, plan, output: lines.slice(-60).join("\n") };
}
/** A base suite at most this long makes checks after landing cheap enough to land more optimistically. */
const FAST_SUITE_MS = 60_000;
/**
 * Limits from what the base measured: when every coverage unit's whole suite runs within a minute, a landing whose
 * closure moved since its fork is checked after landing within a minute or two, and a failure is reverted as fast; it
 * lands optimistically up to 25 moved files in its closure (vuejs/core, one unit whose closures span most of the
 * runtime: at 3, a quarter of its landings waited in checked batches). Slower suites keep 3. Limits a person set stay.
 */
export function calibrate(repo, recordsDir, base) {
    const profile = readProfile(repo);
    if (profile.limits?.maxRisk !== undefined)
        return null;
    const units = profile.coverage ?? [];
    const maps = mapsAt(base, recordsDir).filter((m) => units.length === 0 || units.includes(m.packageDir));
    const timed = maps.filter((m) => typeof m.suiteMs === "number");
    if (timed.length === 0)
        return null;
    const slowest = Math.max(...timed.map((m) => m.suiteMs));
    const fast = slowest <= FAST_SUITE_MS;
    // Fast checks: a change waits for its own verdict (a minute) before landing, which costs less than a revert, and once
    // it passed may land with more of its closure moved. Slow checks: it lands while its verdict runs, with little moved.
    const limits = { ...profile.limits, maxRisk: fast ? 25 : 3, landWhileVerifying: !fast };
    const note = fast
        ? `the base's slowest suite took ${Math.round(slowest / 1000)} s: a change lands on its own passing pre-verification (waiting for it costs less than a revert), with up to 25 moved files in its closure`
        : `the base's slowest suite took ${Math.round(slowest / 1000)} s: a change lands while its pre-verification runs, with up to 3 moved files in its closure`;
    return { limits, note };
}
/** Calibrate and write the limits into the profile (see calibrate). */
export function writeCalibration(repo, recordsDir, base, log) {
    const c = calibrate(repo, recordsDir, base);
    if (!c)
        return;
    const profile = readProfile(repo);
    writeProfile(repo, { ...profile, limits: c.limits, notes: [...(profile.notes ?? []), c.note] });
    log(c.note);
}
/**
 * Discover, review (with `ai`), write, and validate (with `validate`; one repair round with `ai`). The profile is
 * written to the repository's .commons/project.json (or COMMONS_PROFILE).
 */
export async function adapt(repo, opts) {
    const facts = discover(repo);
    opts.log(`${facts.packages.length} workspace package(s), ${facts.toolchain.pm}${facts.toolchain.turbo ? " with turbo" : ""}; root vitest config: ${facts.root.vitestConfig ?? "none"}; ${facts.ci.length} CI workflow(s) that build or test`);
    let profile = draftProfile(facts);
    let costUsd = 0;
    if (opts.ai) {
        opts.log("reviewing the draft with a model that reads the repository");
        const reviewed = await reviewProfile(repo, facts, profile, { ...(opts.model ? { model: opts.model } : {}) });
        if (reviewed) {
            profile = guard(repo, reviewed.profile, facts);
            costUsd += reviewed.costUsd;
        }
        else
            opts.log("the review returned no usable profile; keeping the draft");
    }
    // Keep what a person already set that the draft does not decide (records, env, limits).
    const existing = readProfile(repo);
    profile = { ...existing, ...profile, ...(existing.records && !profile.records ? { records: existing.records } : {}) };
    let path = writeProfile(repo, profile);
    for (const note of profile.notes ?? [])
        opts.log(`  ${note}`);
    let validation = null;
    if (opts.validate) {
        validation = await validateProfile(repo, opts.log);
        if (!validation.ok && opts.ai) {
            opts.log("validation failed; asking the model to correct the profile with the failure");
            const fixed = await reviewProfile(repo, facts, profile, { ...(opts.model ? { model: opts.model } : {}), failure: validation.output });
            if (fixed) {
                costUsd += fixed.costUsd;
                profile = guard(repo, { ...profile, ...fixed.profile }, facts);
                path = writeProfile(repo, profile);
                validation = await validateProfile(repo, opts.log);
            }
        }
    }
    return { profile, path, facts, validation, costUsd };
}
//# sourceMappingURL=adapt.js.map