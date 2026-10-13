// Which tests a change can affect, from the base's function coverage, and whether two changes interact.
//
// Two changes made apart can only break each other through a test that executes code both of them change: what one
// change does is invisible to tests that never reach the other. That is the question behind landing first and checking
// changes together, and the answer is in the coverage maps (tia.ts): which test files executed which function at the
// base. The import closure the optimistic gate used before answers a much wider question (a wrangler change's closure
// spans some 900 files), so changes that could not affect each other went through checked batches, and checks of
// several changes ran tests that only one of them could reach.
//
// A change's impact: for each changed file, the functions whose own code changed (matched by qualified name across the
// two versions, so moved lines do not count, and mapped to their position at the base), and the tests that executed
// them in any package's map (cross-package maps key other packages' functions by repository path); tests that loaded a
// file whose module scope changed; changed test files themselves. A change no map can place (a package without a map,
// a non-source file in a package) is a wildcard for its package: it may affect anything there.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { mapsAt } from "./check.js";
import { nearestBase } from "./records.js";
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORED = /(^|\/)(CHANGELOG\.md|README\.md)$|^\.changeset\/|\.md$/;
function git(repo, args) {
    try {
        return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    }
    catch {
        return null;
    }
}
function show(repo, rev, path) {
    return git(repo, ["show", `${rev}:${path}`]);
}
/**
 * Every function with a body, by qualified name (enclosing functions and classes, then its own name or the variable
 * or property it is assigned to; repeated names numbered in order), with its position and its own text: the text of
 * the function without the functions nested in it, so a change inside a nested function changes only that one.
 */
export function namedFunctions(code, file) {
    const kind = file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
    const functions = new Map();
    const seen = new Map();
    const top = [];
    const isFn = (n) => (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && !!n.body;
    const nameOf = (n) => {
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isClassDeclaration(n)) && n.name)
            return n.name.getText(sf);
        if (ts.isConstructorDeclaration(n))
            return "constructor";
        const p = n.parent;
        if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name)
            return p.name.getText(sf);
        if (p && ts.isCallExpression(p))
            return `${p.expression.getText(sf).slice(0, 40)}()`;
        return "<anonymous>";
    };
    const ownText = (n) => {
        const nested = [];
        const collect = (c) => {
            if (isFn(c)) {
                nested.push([c.getStart(sf), c.getEnd()]);
                return;
            }
            ts.forEachChild(c, collect);
        };
        ts.forEachChild(n, collect);
        let text = "";
        let at = n.getStart(sf);
        for (const [s, e] of nested) {
            text += code.slice(at, s) + "\u0000";
            at = e;
        }
        return (text + code.slice(at, n.getEnd())).replace(/\s+/g, " ");
    };
    // What TypeScript erases at module scope (types, interfaces, type-only imports and exports) changes no behaviour.
    const erased = (n) => ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) ||
        (ts.isImportDeclaration(n) && !!n.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(n) && n.isTypeOnly) ||
        (ts.isModuleDeclaration(n) && !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword));
    const visit = (n, scope, depth) => {
        if (depth === 0 && n.parent === sf && erased(n)) {
            top.push([n.getStart(sf), n.getEnd()]);
            return;
        }
        if (isFn(n)) {
            const base = `${scope}${nameOf(n)}`;
            const k = seen.get(base) ?? 0;
            seen.set(base, k + 1);
            const name = k === 0 ? base : `${base}~${k}`;
            functions.set(name, { start: sf.getLineAndCharacterOfPosition(n.getStart(sf)), own: ownText(n) });
            if (depth === 0)
                top.push([n.getStart(sf), n.getEnd()]);
            ts.forEachChild(n, (c) => visit(c, `${name}/`, depth + 1));
            return;
        }
        if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
            ts.forEachChild(n, (c) => visit(c, `${scope}${nameOf(n)}.`, depth));
            return;
        }
        ts.forEachChild(n, (c) => visit(c, scope, depth));
    };
    visit(sf, "", 0);
    let moduleText = "";
    let at = 0;
    for (const [s, e] of top.sort((a, b) => a[0] - b[0])) {
        moduleText += code.slice(at, s) + "\u0000";
        at = e;
    }
    moduleText = (moduleText + code.slice(at)).replace(/\s+/g, " ");
    // Each top-level statement by name, with its text outside the functions it holds, and what a change to it can
    // reach (as the planner classifies it, tia.ts): an import, or a value that carries functions (an object or a call
    // with function arguments: wrangler defines its commands so), reaches the tests that executed the file's functions;
    // a plain value reaches every test that loaded the module.
    const statements = new Map();
    const counts = new Map();
    for (const st of sf.statements) {
        if (erased(st) || isFn(st))
            continue;
        const decl = ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText(sf)).join(",") : ts.isClassDeclaration(st) && st.name ? st.name.text : "";
        const key0 = `${ts.SyntaxKind[st.kind]}:${decl || (ts.isImportDeclaration(st) ? st.moduleSpecifier.getText(sf) : "")}`;
        const k = counts.get(key0) ?? 0;
        counts.set(key0, k + 1);
        let carries = ts.isImportDeclaration(st) || ts.isClassDeclaration(st);
        const look = (n) => {
            if (carries)
                return;
            if (isFn(n))
                carries = true;
            else
                ts.forEachChild(n, look);
        };
        look(st);
        statements.set(k === 0 ? key0 : `${key0}~${k}`, { text: ownText(st), scope: carries ? "file" : "module" });
    }
    return { functions, moduleText, statements };
}
/** The qualified names whose own code differs between two versions of a file, and whether its module scope did. */
export function changedFunctions(before, after, file) {
    const a = before === null ? null : namedFunctions(before, file);
    const b = after === null ? null : namedFunctions(after, file);
    const names = new Set();
    for (const [name, f] of a?.functions ?? [])
        if (b?.functions.get(name)?.own !== f.own)
            names.add(name);
    for (const name of b?.functions.keys() ?? [])
        if (!a?.functions.has(name))
            names.add(name);
    // A file added or removed whole: everything that loaded it.
    if (!a || !b)
        return { names, scope: "module" };
    let scope = "none";
    const keys = new Set([...a.statements.keys(), ...b.statements.keys()]);
    for (const key of keys) {
        const x = a.statements.get(key);
        const y = b.statements.get(key);
        if (x?.text === y?.text)
            continue;
        if ((x ?? y).scope === "module" || (y ?? x).scope === "module")
            return { names, scope: "module" };
        scope = "file";
    }
    return { names, scope };
}
/** The map whose package contains `path` (the deepest), and the path relative to it. */
function ownMap(maps, path) {
    let best = null;
    for (const m of maps) {
        const dir = m.packageDir === "." || m.packageDir === "" ? "" : `${m.packageDir}/`;
        if (dir && !path.startsWith(dir))
            continue;
        if (!best || dir.length > (best.map.packageDir === "." ? 0 : best.map.packageDir.length + 1))
            best = { map: m, rel: path.slice(dir.length) };
    }
    return best;
}
function packageOf(path, maps) {
    const own = ownMap(maps, path);
    if (own)
        return own.map.packageDir;
    const m = /^(packages|apps|libs|fixtures)\/[^/]+/.exec(path);
    return m ? m[0] : ".";
}
/**
 * The impact of the change `from`..`to` in `repo`, by the coverage maps recorded at the nearest base of `to` in
 * `recordsDir`. Null when no map is recorded there (nothing to say; callers keep their previous rule).
 */
export function impactOf(repo, from, to, recordsDir) {
    const base = nearestBase(repo, recordsDir, to);
    if (!base)
        return null;
    const maps = mapsAt(base, recordsDir);
    if (maps.length === 0)
        return null;
    const files = (git(repo, ["diff", "--name-only", from, to]) ?? "").split("\n").filter(Boolean);
    const impact = { tests: new Set(), wildcard: new Set(), files };
    for (const path of files) {
        if (IGNORED.test(path))
            continue;
        const own = ownMap(maps, path);
        if (TEST.test(path)) {
            if (own)
                impact.tests.add(`${own.map.packageDir}::${own.rel}`);
            else
                impact.wildcard.add(packageOf(path, maps));
            continue;
        }
        const atBase = SOURCE.test(path) && own ? show(repo, base, path) : null;
        // A source file the base did not have reaches tests only through the changed code that uses it, counted there.
        if (SOURCE.test(path) && own && atBase === null)
            continue;
        if (!SOURCE.test(path) || !own || !own.map.functions[own.rel]) {
            impact.wildcard.add(packageOf(path, maps));
            continue;
        }
        const changed = changedFunctions(show(repo, from, path), show(repo, to, path), path);
        const positions = atBase === null ? new Map() : namedFunctions(atBase, path).functions;
        const ids = [];
        for (const name of changed.names) {
            const f = positions.get(name);
            if (f)
                ids.push(`#${f.start.line + 1}:${f.start.character}`);
        }
        if (changed.scope === "module")
            ids.push("#module");
        // A value that carries functions changed: the tests that executed any function of the file.
        if (changed.scope === "file")
            for (const span of own.map.functions[own.rel] ?? [])
                ids.push(span.id.slice(span.id.indexOf("#")));
        for (const m of maps) {
            // A map keys its own package's functions by package-relative path, others' by repository path.
            const key = m === own.map ? own.rel : path;
            for (const id of ids)
                for (const t of m.hits[`${key}${id}`] ?? [])
                    impact.tests.add(`${m.packageDir}::${t}`);
        }
    }
    return impact;
}
/** The tests through which two changes can affect each other, or "unknown" when a wildcard could reach the other. */
export function sharedTests(a, b, maps = []) {
    const touches = (impact, pkg) => pkg === "." || impact.files.some((f) => packageOf(f, maps) === pkg) || [...impact.tests].some((t) => t.startsWith(`${pkg}::`));
    for (const pkg of a.wildcard)
        if (touches(b, pkg))
            return "unknown";
    for (const pkg of b.wildcard)
        if (touches(a, pkg))
            return "unknown";
    return new Set([...a.tests].filter((t) => b.tests.has(t)));
}
//# sourceMappingURL=interaction.js.map