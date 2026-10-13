// Base records for the verification planner: per base commit, each package's declaration surface (surface.ts) and its
// function-coverage map (tia.ts). A check compares a change against the nearest recorded base that is an ancestor of
// what it checks, so records built once on main keep selecting for every later candidate: changes landed since the
// base only add to what is selected, never hide anything.
//
// Layout: `surface/<commit>.json`, `tia/<commit>/<package>.json`, and `ci/<commit>/<package>.json`.
// The directory is `--records`, else COMMONS_VERIFY_DIR, else the project profile's, else one per repository under
// `~/.commons/verify` (recordsDirOf in profile.ts); verifyDir() is the machine-wide default without a repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export function verifyDir() {
    return process.env.COMMONS_VERIFY_DIR ?? join(homedir(), ".commons", "verify");
}
const fileKey = (packageDir) => (packageDir === "." || packageDir === "" ? "__root" : packageDir.replace(/[/\\]/g, "__"));
export function surfaceFile(base, dir = verifyDir()) {
    return join(dir, "surface", `${base}.json`);
}
export function tiaFile(base, packageDir, dir = verifyDir()) {
    return join(dir, "tia", base, `${fileKey(packageDir)}.json`);
}
export function readBaseSurfaces(base, dir = verifyDir()) {
    const path = surfaceFile(base, dir);
    if (!existsSync(path))
        return null;
    try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        // The first format recorded the hash alone.
        return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, typeof value === "string" ? { hash: value } : value]));
    }
    catch {
        return null;
    }
}
/** Merge `surfaces` into the record of `base` (packages recorded earlier stay). */
export function writeBaseSurfaces(base, surfaces, dir = verifyDir()) {
    const path = surfaceFile(base, dir);
    mkdirSync(dirname(path), { recursive: true });
    const merged = { ...(readBaseSurfaces(base, dir) ?? {}), ...surfaces };
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
    return path;
}
export function readTiaMap(base, packageDir, dir = verifyDir()) {
    try {
        return JSON.parse(readFileSync(tiaFile(base, packageDir, dir), "utf8"));
    }
    catch {
        return null;
    }
}
export function writeTiaMap(map, dir = verifyDir()) {
    const path = tiaFile(map.root, map.packageDir, dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(map));
    return path;
}
export function readCiBase(base, packageDir, dir = verifyDir()) {
    try {
        return JSON.parse(readFileSync(join(dir, "ci", base, `${fileKey(packageDir)}.json`), "utf8"));
    }
    catch {
        return null;
    }
}
export function writeCiBase(record, dir = verifyDir()) {
    const path = join(dir, "ci", record.base, `${fileKey(record.packageDir)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
    return path;
}
/** Every commit with a record of either kind. */
export function recordedBases(dir = verifyDir()) {
    const out = new Set();
    try {
        for (const f of readdirSync(join(dir, "surface")))
            if (/^[0-9a-f]{40}\.json$/.test(f))
                out.add(f.slice(0, 40));
    }
    catch {
        // none
    }
    for (const kind of ["tia", "ci"]) {
        try {
            for (const f of readdirSync(join(dir, kind)))
                if (/^[0-9a-f]{40}$/.test(f))
                    out.add(f);
        }
        catch {
            // none
        }
    }
    return [...out].sort();
}
function gitOut(repo, args) {
    try {
        return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
    }
    catch {
        return null;
    }
}
/**
 * The recorded base a check of `rev` (default HEAD) compares against: among the recorded commits that are ancestors of
 * it, the one with the fewest commits between, so the diff it selects tests by is the smallest. Null when none is.
 */
export function nearestBase(repo, dir = verifyDir(), rev = "HEAD") {
    let best = null;
    for (const base of recordedBases(dir)) {
        if (gitOut(repo, ["merge-base", "--is-ancestor", base, rev]) === null)
            continue;
        const distance = Number(gitOut(repo, ["rev-list", "--count", `${base}..${rev}`]) ?? Number.POSITIVE_INFINITY);
        if (!best || distance < best.distance)
            best = { base, distance };
    }
    return best?.base ?? null;
}
/** The repository's root commit: the base of a benchmark checkout, whose history is one orphan commit plus the work on it. */
export function rootCommit(repo) {
    return gitOut(repo, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n")[0] || null;
}
//# sourceMappingURL=records.js.map