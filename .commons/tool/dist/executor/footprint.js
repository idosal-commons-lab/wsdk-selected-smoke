import { indexRepo } from "../index/symbols.js";
export const FOOTPRINT_EXCLUDE = /(^|\/)(node_modules|dist|build|out|coverage|\.turbo|\.git|\.cache)(\/|$)/;
export const FOOTPRINT_MAX_FILES = 20000;
/** Files whose change can affect any test without being imported by it. */
export const GLOBAL_PATH = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|vitest[^/]*\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|babel\.config\.[cm]?js|\.babelrc|\.env[^/]*)$/;
/** Index a checked-out tree for closure queries; incomplete (truncated) indexes answer null, which forbids transfer. */
export function closureIndex(root, opts = {}) {
    const maxFiles = opts.maxFiles ?? FOOTPRINT_MAX_FILES;
    const index = indexRepo(root, { exclude: opts.exclude ?? FOOTPRINT_EXCLUDE, maxFiles });
    const complete = index.files.length < maxFiles;
    return { files: index.files.length, complete, closureOf: (changed) => (complete ? closureOf(index, changed) : null) };
}
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
function intersect(a, b) {
    if (a === "*")
        return b === "*" ? "*" : new Set(b);
    if (b === "*")
        return new Set(a);
    return new Set([...a].filter((n) => b.has(n)));
}
function empty(n) {
    return n !== "*" && n.size === 0;
}
function bindingNames(names) {
    return names === "*" ? "*" : new Set(names);
}
class Affected {
    map = new Map();
    /** Returns true when `names` added something new for `path`. */
    add(path, names) {
        const cur = this.map.get(path);
        if (cur === "*")
            return false;
        if (names === "*") {
            this.map.set(path, "*");
            return true;
        }
        if (!cur) {
            this.map.set(path, new Set(names));
            return names.size > 0;
        }
        let grew = false;
        for (const n of names) {
            if (cur.has(n))
                continue;
            cur.add(n);
            grew = true;
        }
        return grew;
    }
}
/**
 * What importing `names` from a pure barrel depends on: the barrel itself for those names (its re-export lines), and
 * the concrete modules behind them, whole, resolved through nested barrels. A concrete module is always a whole-file
 * dependency: any change inside it can alter what it exports.
 */
function resolveThroughBarrel(index, barrel, names, out = new Map(), seen = new Set()) {
    if (seen.has(barrel.path))
        return out;
    seen.add(barrel.path);
    out.set(barrel.path, mergeNames(out.get(barrel.path), names));
    for (const b of barrel.bindings ?? []) {
        if (!b.reexport)
            continue;
        const wanted = intersect(names, bindingNames(b.names));
        if (empty(wanted))
            continue;
        const target = index.byPath.get(b.from);
        if (target?.pureBarrel) {
            resolveThroughBarrel(index, target, wanted, out, seen);
            continue;
        }
        // Only modules that actually export a wanted name count when the wanted set is explicit.
        if (wanted !== "*" && target && !target.exports.some((e) => wanted.has(e.name)))
            continue;
        out.set(b.from, "*");
    }
    return out;
}
function mergeNames(a, b) {
    if (!a)
        return b === "*" ? "*" : new Set(b);
    if (a === "*" || b === "*")
        return "*";
    return new Set([...a, ...b]);
}
/**
 * Upward: every file whose behaviour can observe the changed exports, passing through pure barrels by name.
 * Downward: the dependencies of those files, pruning through barrels by the names imported. Always includes the change.
 */
export function closureOf(index, changed) {
    const affected = new Affected();
    const work = [];
    for (const c of changed) {
        const path = norm(c.path);
        // Symbol granularity applies to barrels only (a re-export line per name); a change anywhere in a concrete module
        // can alter any of its exports, so it counts whole.
        const names = index.byPath.get(path)?.pureBarrel && c.symbols && c.symbols.length > 0 ? new Set(c.symbols) : "*";
        if (affected.add(path, names))
            work.push([path, names]);
    }
    while (work.length) {
        const [path, names] = work.pop();
        // A whole-file change to a concrete module flows onward as that module's export names, so a re-exporting barrel
        // passes only those names to its importers.
        const source = index.byPath.get(path);
        const flowing = names === "*" && source && !source.pureBarrel && source.exports.length > 0 ? new Set(source.exports.map((e) => e.name)) : names;
        for (const importerPath of index.importers.get(path) ?? []) {
            const importer = index.byPath.get(importerPath);
            if (!importer)
                continue;
            const bindings = (importer.bindings ?? []).filter((b) => b.from === path);
            // Fixtures without bindings: a plain import edge means the whole importer may observe the change.
            if (bindings.length === 0) {
                if (affected.add(importerPath, "*"))
                    work.push([importerPath, "*"]);
                continue;
            }
            for (const b of bindings) {
                const touched = intersect(flowing, bindingNames(b.names));
                if (empty(touched))
                    continue;
                const propagate = importer.pureBarrel && b.reexport ? touched : "*";
                if (affected.add(importerPath, propagate))
                    work.push([importerPath, propagate]);
            }
        }
    }
    // Downward from every affected file.
    const deps = new Affected();
    const down = [...affected.map.entries()];
    const visited = new Set();
    while (down.length) {
        const [path, names] = down.pop();
        const key = `${path}|${names === "*" ? "*" : [...names].sort().join(",")}`;
        if (visited.has(key))
            continue;
        visited.add(key);
        const file = index.byPath.get(path);
        if (!file)
            continue;
        if (file.pureBarrel && names !== "*") {
            for (const [p, n] of resolveThroughBarrel(index, file, names))
                if (deps.add(p, n))
                    down.push([p, n]);
            continue;
        }
        const bindings = file.bindings;
        if (!bindings) {
            for (const dep of file.imports)
                if (deps.add(dep, "*"))
                    down.push([dep, "*"]);
            continue;
        }
        for (const b of bindings) {
            const target = index.byPath.get(b.from);
            if (target?.pureBarrel && b.names !== "*") {
                for (const [p, n] of resolveThroughBarrel(index, target, bindingNames(b.names)))
                    if (deps.add(p, n))
                        down.push([p, n]);
            }
            else if (deps.add(b.from, "*"))
                down.push([b.from, "*"]);
        }
    }
    const out = new Set();
    const emit = (map) => {
        for (const [p, n] of map) {
            if (n === "*")
                out.add(p);
            else
                for (const name of n)
                    out.add(`${p}#${name}`);
        }
    };
    emit(affected.map);
    emit(deps.map);
    // A whole-file entry subsumes its per-name entries.
    for (const e of [...out])
        if (e.includes("#") && out.has(e.slice(0, e.indexOf("#"))))
            out.delete(e);
    return [...out].sort();
}
/** The footprint of a landing that changed `changed` on the tree `index` describes. */
export function footprintOf(index, changed) {
    const paths = changed.map((c) => norm(c.path));
    const changedSymbols = {};
    for (const c of changed)
        changedSymbols[norm(c.path)] = [...(c.symbols ?? [])];
    if (!index || paths.some((p) => GLOBAL_PATH.test(p)))
        return { changed: paths, changedSymbols, closure: null };
    return { changed: paths, changedSymbols, closure: index.closureOf(changed) };
}
/** Does a change (paths with optional symbols) touch anything in `closure`? */
export function touches(changed, closure) {
    const set = new Set(closure);
    for (const [path, symbols] of Object.entries(changed)) {
        if (set.has(path))
            return true;
        if (symbols.length === 0) {
            if (closure.some((e) => e.startsWith(`${path}#`)))
                return true;
        }
        else if (symbols.some((s) => set.has(`${path}#${s}`)))
            return true;
    }
    return false;
}
function changesOf(f) {
    if (f.changedSymbols)
        return f.changedSymbols;
    return Object.fromEntries(f.changed.map((p) => [p, []]));
}
export function footprintsDisjoint(a, b) {
    if (!a.closure || !b.closure)
        return false;
    return !touches(changesOf(a), b.closure) && !touches(changesOf(b), a.closure);
}
/** The landings that moved main from `fromMain` to `current`, in order, or null when the chain cannot be followed. */
export function landingsBetween(all, fromMain, current) {
    const out = [];
    const seen = new Set();
    let main = fromMain;
    while (main !== current) {
        if (seen.has(main))
            return null;
        seen.add(main);
        const last = out.length ? out[out.length - 1].seq : -1;
        const next = all.find((l) => l.fromMain === main && l.seq > last);
        if (!next)
            return null;
        out.push(next);
        main = next.toMain;
    }
    return out;
}
/** A verdict with footprint `mine` transfers across `between` when every landing there is footprint-disjoint from it. */
export function transferable(mine, between) {
    return mine.closure !== null && between.every((l) => l.footprint !== undefined && footprintsDisjoint(mine, l.footprint));
}
//# sourceMappingURL=footprint.js.map