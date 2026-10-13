// The declaration surface of a workspace package: a hash of the declaration files its manifest points consumers at
// (`types`, `typings`, and every `types` condition under `exports`), taken from the package's build output. A change
// that leaves it unchanged cannot break another package's type check, so the gate type-checks only the package
// itself; a change that alters it (a widened union, a new parameter) type-checks every dependent too.
//
// Measured on the fifth twenty-five-issue run: a check's test run took 0.4 to 2 s of a 240 to 340 s total, the rest
// being builds and the type checks of up to 127 dependents; and 13 of the third run's 15 landings changed no
// exported signature.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
const DECLARATION = /\.d\.[mc]?ts$/;
/** The declaration entry points a manifest names, relative to the package directory. */
export function declarationEntries(manifest) {
    const out = [];
    for (const key of ["types", "typings"]) {
        const value = manifest[key];
        if (typeof value === "string")
            out.push(value);
    }
    const walk = (node) => {
        if (!node || typeof node !== "object")
            return;
        for (const [key, value] of Object.entries(node)) {
            if (key === "types" && typeof value === "string")
                out.push(value);
            else
                walk(value);
        }
    };
    walk(manifest.exports);
    return [...new Set(out.map((e) => normalize(e).replace(/^\.\//, "").replace(/\/+$/, "")))];
}
function declarationsUnder(path, out) {
    let stat;
    try {
        stat = statSync(path);
    }
    catch {
        return;
    }
    if (stat.isFile()) {
        if (DECLARATION.test(path))
            out.push(path);
        return;
    }
    if (!stat.isDirectory())
        return;
    for (const name of readdirSync(path).sort()) {
        if (name === "node_modules")
            continue;
        declarationsUnder(join(path, name), out);
    }
}
/** The declaration file a relative specifier in a declaration file points at (`./chunk-x.mjs` -> `./chunk-x.d.mts`). */
export function declarationTarget(from, specifier) {
    if (!specifier.startsWith("."))
        return null;
    const base = join(dirname(from), specifier);
    const stem = base.replace(/\.[mc]?[jt]sx?$/, "");
    const candidates = [
        base.replace(/\.mjs$/, ".d.mts"),
        base.replace(/\.cjs$/, ".d.cts"),
        ...[".d.ts", ".d.mts", ".d.cts"].map((x) => `${stem}${x}`),
        ...[".d.ts", ".d.mts", ".d.cts"].map((x) => join(base, `index${x}`)),
        base,
    ];
    return candidates.find((c) => DECLARATION.test(c) && existsSync(c) && statSync(c).isFile()) ?? null;
}
/** An entry's declaration file: the path itself, or the index of a directory entry (`"types": "./dist"`). */
function entryFile(packageDir, entry) {
    const candidates = [join(packageDir, entry), ...["d.ts", "d.mts", "d.cts"].map((x) => join(packageDir, entry, `index.${x}`))];
    return candidates.find((c) => DECLARATION.test(c) && existsSync(c) && statSync(c).isFile()) ?? null;
}
/**
 * The declaration files consumers can reach: the type entries and every declaration file they import or re-export,
 * transitively. Builds that do not clean their output leave stale chunks beside the new ones; those are not part of
 * the surface. Falls back to every declaration file under the entries' directories when an entry is a directory with
 * no index.
 */
export function reachableDeclarations(packageDir, manifest) {
    const entries = declarationEntries(manifest);
    const queue = entries.map((e) => entryFile(packageDir, e)).filter((f) => f !== null);
    if (queue.length === 0) {
        const files = [];
        for (const root of [...new Set(entries.map((e) => e.split("/")[0]).filter((r) => r && r !== ".."))].sort())
            declarationsUnder(join(packageDir, root), files);
        return files;
    }
    const seen = new Set();
    const specifiers = /(?:from\s*|import\(\s*|<reference\s+path=)["']([^"']+)["']/g;
    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file))
            continue;
        seen.add(file);
        let text = "";
        try {
            text = readFileSync(file, "utf8");
        }
        catch {
            continue;
        }
        for (const m of text.matchAll(specifiers)) {
            const target = declarationTarget(file, m[1]);
            if (target && !seen.has(target))
                queue.push(target);
        }
    }
    return [...seen].sort();
}
/**
 * Hash of the package's declaration surface: the declaration files reachable from its type entries. Null when the
 * manifest names none or none is built.
 */
export function declarationSurface(packageDir) {
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    }
    catch {
        return null;
    }
    const files = reachableDeclarations(packageDir, manifest);
    if (files.length === 0)
        return null;
    const hash = createHash("sha256");
    for (const file of [...new Set(files)].sort()) {
        hash.update(file.slice(packageDir.length));
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
    }
    return hash.digest("hex");
}
export { readBaseSurfaces, surfaceFile, writeBaseSurfaces } from "./records.js";
//# sourceMappingURL=surface.js.map