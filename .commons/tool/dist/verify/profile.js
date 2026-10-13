// The project profile: what Commons learned about a repository when it was installed (`commons adapt`), kept in
// `.commons/project.json` and committed with the repository. How its tests are laid out and run, what a check must build
// first and how, how it type-checks, where the base records live, and the limits the queue works with. Every field has a
// default that works without it; the profile is what makes a check of this repository fast and right instead of generic.
//
// COMMONS_PROFILE=<path> reads a profile from elsewhere (a benchmark keeps its own beside the workload).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
export function profilePath(repo) {
    return process.env.COMMONS_PROFILE ? resolve(process.env.COMMONS_PROFILE) : join(repo, ".commons", "project.json");
}
const cache = new Map();
/** The repository's profile, or an empty one. Re-read when the file changes. */
export function readProfile(repo) {
    const path = profilePath(repo);
    let mtimeMs;
    try {
        mtimeMs = statSync(path).mtimeMs;
    }
    catch {
        return {};
    }
    const known = cache.get(path);
    if (known && known.mtimeMs === mtimeMs)
        return known.profile;
    let profile = {};
    try {
        profile = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        throw new Error(`unreadable project profile ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    cache.set(path, { mtimeMs, profile });
    return profile;
}
export function writeProfile(repo, profile) {
    const path = profilePath(repo);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, ...profile }, null, 2) + "\n");
    cache.delete(path);
    return path;
}
/** The repository's first commit: the same for every clone and worktree of it, so records are shared between them. */
function rootCommitOf(repo) {
    try {
        return execFileSync("git", ["-C", repo, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).trim().split("\n").pop() ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Where a repository's base records live: --records, COMMONS_VERIFY_DIR, the profile's `records`, else
 * `~/.commons/verify/<root commit>` (one directory per repository on the machine, whichever clone checks).
 */
export function recordsDirOf(repo, flag) {
    if (flag)
        return resolve(flag);
    if (process.env.COMMONS_VERIFY_DIR)
        return process.env.COMMONS_VERIFY_DIR;
    const profile = readProfile(repo);
    if (profile.records)
        return isAbsolute(profile.records) ? profile.records : resolve(repo, profile.records);
    const legacy = join(repo, ".commons", "verify");
    if (existsSync(legacy))
        return legacy;
    return join(homedir(), ".commons", "verify", rootCommitOf(repo) ?? "unknown");
}
/** Environment for builds, type checks and tests: non-interactive, no telemetry, plus the profile's. */
export function checkEnv(repo) {
    // No DO_NOT_TRACK: some test suites read it (wrangler's telemetry tests fail when it is set); turbo's telemetry is
    // silenced by TURBO_TELEMETRY_DISABLED alone.
    return { TURBO_TELEMETRY_DISABLED: "1", TURBO_UI: "0", CI: "1", COREPACK_ENABLE_STRICT: "0", ...readProfile(repo).env };
}
/** The profile's build commands keyed by package name (how the build helpers look them up). */
export function buildOverrides(repo, nameOf) {
    const out = {};
    for (const [dir, p] of Object.entries(readProfile(repo).packages ?? {})) {
        if (!p.build)
            continue;
        const name = nameOf(dir);
        if (name)
            out[name] = p.build;
    }
    return out;
}
/** A package's profile entry, by directory. */
export function packageProfile(repo, dir) {
    return readProfile(repo).packages?.[dir === "" ? "." : dir] ?? {};
}
//# sourceMappingURL=profile.js.map