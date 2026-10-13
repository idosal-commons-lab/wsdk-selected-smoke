// Which dependents a change to a package can break, by name: the declarations whose text changed against the base
// (and every declaration that mentions one, to a fixpoint), and the direct dependents whose source imports one of
// those names. A change that widens one union in workers-auth then type-checks workers-auth and wrangler, which
// imports that union, instead of the 127 packages that depend on workers-auth one way or another.
import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { declarationEntries, declarationTarget, reachableDeclarations } from "./surface.js";
const SOURCE = /\.(?:[mc]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".wrangler", "coverage", ".git"]);
function walk(path, match, out, skip = SKIP_DIRS) {
    let stat;
    try {
        stat = statSync(path);
    }
    catch {
        return;
    }
    if (stat.isFile()) {
        if (match.test(path))
            out.push(path);
        return;
    }
    if (!stat.isDirectory())
        return;
    for (const name of readdirSync(path).sort()) {
        if (skip.has(name))
            continue;
        walk(join(path, name), match, out, skip);
    }
}
/** Bundlers name chunks by content hash (`context-B7aozQRl.d.mts`): the hash must not make every importer look changed. */
function normalize(text) {
    return text.replace(/-[A-Za-z0-9_]{8}((?:\.d)?\.[mc]?[jt]s)/g, "-<chunk>$1").replace(/\s+/g, " ").trim();
}
function declaredNames(st) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
        return st.name ? [st.name.text] : ["default"];
    }
    if (ts.isModuleDeclaration(st))
        return [st.name.text];
    if (ts.isVariableStatement(st))
        return st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
    return [];
}
const hasExportModifier = (st) => ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
/**
 * The declarations of a package's built type entries (every declaration file under their output directories), keyed
 * by declared name, and what each public name resolves to. Bundlers export declarations under minified aliases that
 * shift when anything is added (`export { ConfigStorage as a }`): those lines are bindings, not declarations, and are
 * resolved per file instead of hashed.
 */
export function declarationIndex(packageDir) {
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    }
    catch {
        return null;
    }
    const entries = declarationEntries(manifest);
    const files = reachableDeclarations(packageDir, manifest);
    if (files.length === 0)
        return null;
    const texts = new Map();
    const bindings = new Map();
    for (const file of files) {
        const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        const b = { exports: new Map(), stars: [], imports: new Map(), declared: new Set() };
        for (const st of sf.statements) {
            if (ts.isImportDeclaration(st)) {
                const target = ts.isStringLiteral(st.moduleSpecifier) ? declarationTarget(file, st.moduleSpecifier.text) : null;
                const named = st.importClause?.namedBindings;
                if (target && named && ts.isNamedImports(named)) {
                    for (const el of named.elements)
                        b.imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
                }
                continue;
            }
            if (ts.isExportDeclaration(st)) {
                const target = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? declarationTarget(file, st.moduleSpecifier.text) : null;
                if (!st.exportClause) {
                    if (target)
                        b.stars.push(target);
                }
                else if (ts.isNamedExports(st.exportClause)) {
                    for (const el of st.exportClause.elements) {
                        const name = (el.propertyName ?? el.name).text;
                        b.exports.set(el.name.text, target ? { file: target, name } : { local: name });
                    }
                }
                continue;
            }
            if (ts.isExportAssignment(st))
                continue;
            const names = declaredNames(st);
            if (names.length === 0)
                continue;
            const text = normalize(st.getText(sf));
            for (const name of names) {
                texts.set(name, texts.has(name) ? `${texts.get(name)}\n${text}` : text);
                b.declared.add(name);
                if (hasExportModifier(st))
                    b.exports.set(name, { local: name });
            }
        }
        bindings.set(file, b);
    }
    // Follow an export of a file to the declared name behind it.
    const resolveExport = (file, name, seen = new Set()) => {
        const key = `${file}#${name}`;
        if (seen.has(key))
            return null;
        seen.add(key);
        const b = bindings.get(file);
        if (!b)
            return null;
        const e = b.exports.get(name);
        if (e && "local" in e) {
            if (b.declared.has(e.local))
                return e.local;
            const imported = b.imports.get(e.local);
            return imported ? resolveExport(imported.file, imported.name, seen) : e.local;
        }
        if (e)
            return resolveExport(e.file, e.name, seen);
        for (const star of b.stars) {
            const r = resolveExport(star, name, seen);
            if (r)
                return r;
        }
        return null;
    };
    const exportNames = (file, seen = new Set()) => {
        if (seen.has(file))
            return [];
        seen.add(file);
        const b = bindings.get(file);
        if (!b)
            return [];
        return [...b.exports.keys(), ...b.stars.flatMap((s) => exportNames(s, seen))];
    };
    const exported = new Map();
    for (const entry of entries) {
        const file = [join(packageDir, entry), ...["d.ts", "d.mts", "d.cts"].map((x) => join(packageDir, entry, `index.${x}`))].find((f) => bindings.has(f));
        if (!file)
            continue;
        for (const name of exportNames(file)) {
            const declared = resolveExport(file, name);
            if (declared && !exported.has(name))
                exported.set(name, declared);
        }
    }
    return { texts, exported };
}
const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
/** Declared name -> hash of its declarations, recorded for the base at prepare. */
export function declarationHashes(index) {
    return Object.fromEntries([...index.texts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, text]) => [name, sha(text)]));
}
const identifiers = (text) => new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
/**
 * Names that changed against the base: declared names whose declarations differ (added, removed or changed), closed
 * over mentions (a declaration that names a changed one changed too: its meaning did), and the public names that
 * resolve to any of them.
 */
export function changedDeclarations(base, current) {
    const now = declarationHashes(current);
    const changed = new Set();
    for (const name of new Set([...Object.keys(base), ...Object.keys(now)]))
        if (base[name] !== now[name])
            changed.add(name);
    const mentions = new Map([...current.texts].map(([name, text]) => [name, identifiers(text)]));
    for (let grew = true; grew;) {
        grew = false;
        for (const [name, ids] of mentions) {
            if (changed.has(name))
                continue;
            for (const c of changed) {
                if (ids.has(c)) {
                    changed.add(name);
                    grew = true;
                    break;
                }
            }
        }
    }
    for (const [publicName, declared] of current.exported)
        if (changed.has(declared))
            changed.add(publicName);
    return changed;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/**
 * The names a package's source imports from `from` (any subpath), or "all" when it imports the module whole: a
 * namespace or default import, `export *`, a dynamic import or require, `typeof import(...)`.
 */
export function importedNames(packageDir, from) {
    const files = [];
    walk(packageDir, SOURCE, files);
    const spec = `["']${escape(from)}(?:/[^"']*)?["']`;
    const whole = [
        new RegExp(`import\\s+\\*\\s+as\\s+[\\w$]+\\s+from\\s*${spec}`),
        new RegExp(`export\\s+\\*\\s+(?:as\\s+[\\w$]+\\s+)?from\\s*${spec}`),
        new RegExp(`import\\s+(?:type\\s+)?[\\w$]+\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*${spec}`),
        new RegExp(`(?:import|require)\\(\\s*${spec}`),
    ];
    const named = new RegExp(`(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*${spec}`, "g");
    const names = new Set();
    for (const file of files) {
        let text;
        try {
            text = readFileSync(file, "utf8");
        }
        catch {
            continue;
        }
        if (!text.includes(from))
            continue;
        if (whole.some((re) => re.test(text)))
            return "all";
        for (const m of text.matchAll(named)) {
            for (const part of m[1].split(",")) {
                const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
                if (name)
                    names.add(name);
            }
        }
    }
    return names;
}
/** Package-directory patterns: pnpm-workspace.yaml's `packages`, else the root manifest's `workspaces` (npm, yarn). */
export function workspacePatterns(repo) {
    try {
        const yaml = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
        const block = /^packages:\s*\n((?:\s+-\s*.+\n?)+)/m.exec(yaml);
        return block ? [...block[1].matchAll(/-\s*["']?([^"'\n#]+?)["']?\s*$/gm)].map((m) => m[1].trim()) : [];
    }
    catch {
        // not pnpm
    }
    try {
        const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
        const ws = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
        return ws.filter((w) => typeof w === "string");
    }
    catch {
        return [];
    }
}
/** Workspace packages, from `dir` and `dir/*` patterns (pnpm-workspace.yaml, or the root manifest's `workspaces`). */
export function workspacePackages(repo) {
    const patterns = workspacePatterns(repo);
    const dirs = new Set();
    for (const raw of patterns) {
        if (raw.startsWith("!"))
            continue;
        const pattern = raw.replace(/^\.\//, "").replace(/\/$/, "");
        if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
            const parent = pattern.replace(/\/\*\*?$/, "");
            try {
                for (const name of readdirSync(join(repo, parent)))
                    dirs.add(`${parent}/${name}`);
            }
            catch {
                // missing directory
            }
        }
        else
            dirs.add(pattern);
    }
    const out = [];
    for (const dir of [...dirs].sort()) {
        const path = join(repo, dir, "package.json");
        if (!existsSync(path))
            continue;
        try {
            const manifest = JSON.parse(readFileSync(path, "utf8"));
            if (typeof manifest.name === "string")
                out.push({ name: manifest.name, dir, manifest });
        }
        catch {
            // unreadable manifest
        }
    }
    return out;
}
export function directDependents(packages, name) {
    const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    return packages.filter((p) => p.name !== name && fields.some((f) => typeof p.manifest[f] === "object" && p.manifest[f] !== null && name in p.manifest[f]));
}
/**
 * The dependents to type-check for a change whose declaration surface changed in `changed`: every direct dependent
 * that imports one of those names (or the whole module), checked by itself when the base recorded its own surface and
 * the change leaves that surface as it was; followed one level further when it does not (its own changed names select
 * its dependents); and checked with everything that depends on it when no base record narrows it down.
 */
export async function selectDependents(o) {
    const scope = { alone: [], withDependents: [], notes: [] };
    const queue = [{ pkg: o.pkg, changed: o.changed, depth: 0 }];
    const visited = new Set([o.pkg.name]);
    const maxDepth = o.maxDepth ?? 3;
    while (queue.length > 0) {
        const { pkg, changed, depth } = queue.shift();
        const sample = [...changed].slice(0, 4).join(", ") + (changed.size > 4 ? `, +${changed.size - 4}` : "");
        // The dependents that use a changed name, and among them those to build and compare: built in one turbo run (one
        // run per dependent took two minutes for miniflare's eleven), and one by one only when that run fails, to find out
        // whose build the change breaks.
        const using = [];
        for (const dep of directDependents(o.packages, pkg.name)) {
            if (visited.has(dep.name))
                continue;
            const used = importedNames(join(o.repo, dep.dir), pkg.name);
            if (used !== "all" && ![...used].some((n) => changed.has(n)))
                continue;
            visited.add(dep.name);
            using.push({ dep, why: `${dep.name} ${used === "all" ? `imports ${pkg.name} whole` : `uses ${[...used].filter((n) => changed.has(n)).slice(0, 3).join(", ")} from ${pkg.name}`}` });
        }
        const toBuild = using.filter((u) => o.base[u.dep.name]?.decls).map((u) => u.dep.name);
        const builtTogether = toBuild.length > 1 ? await o.build(toBuild) : false;
        for (const { dep, why } of using) {
            const record = o.base[dep.name];
            if (record?.decls) {
                const built = builtTogether || (await o.build([dep.name]));
                if (!built) {
                    // The change breaks the dependent's own build (its declaration build type-checks): the check fails on it.
                    scope.alone.push(dep.name);
                    scope.notes.push(`${why}; its build fails with this change`);
                    continue;
                }
                const now = o.surfaceOf(join(o.repo, dep.dir));
                if (now !== null && now === record.hash) {
                    scope.alone.push(dep.name);
                    scope.notes.push(`${why}; its own surface is unchanged`);
                    continue;
                }
                const index = now !== null && depth + 1 < maxDepth ? declarationIndex(join(o.repo, dep.dir)) : null;
                if (index) {
                    scope.alone.push(dep.name);
                    const next = changedDeclarations(record.decls, index);
                    scope.notes.push(`${why}; its own surface changed in ${next.size} declaration(s)`);
                    if (next.size > 0)
                        queue.push({ pkg: { name: dep.name, dir: dep.dir }, changed: next, depth: depth + 1 });
                    continue;
                }
                scope.withDependents.push(dep.name);
                scope.notes.push(`${why}; its surface could not be compared, so everything depending on it is checked`);
            }
            else if (declarationEntries(dep.manifest).length > 0 || directDependents(o.packages, dep.name).length > 0) {
                scope.withDependents.push(dep.name);
                scope.notes.push(`${why}; no base record, so everything depending on it is checked`);
            }
            else {
                scope.alone.push(dep.name);
                scope.notes.push(why);
            }
        }
        if (depth === 0 && scope.alone.length === 0 && scope.withDependents.length === 0)
            scope.notes.push(`no dependent of ${pkg.name} uses the changed declarations (${sample})`);
    }
    return scope;
}
//# sourceMappingURL=dependents.js.map