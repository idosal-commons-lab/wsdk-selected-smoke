// Test impact analysis by function coverage. `vitest related` follows static imports, and in a package whose tests all
// drive one CLI entry (wrangler: every command is imported eagerly by the entry its tests run) that selects the whole
// suite for any change: 170 test files and 4,346 tests for a three-line fix to the D1 SQL splitter. Instead, the base's
// suite runs once with every function of the package's sources instrumented, recording which test file executed which
// function; a change then runs the test files that executed a function it touches. Anything the map cannot place falls
// back to `vitest related`: changes outside any function (module scope, where every importer is affected), files the
// map does not know (new files, data, templates), and changed test files always run.
import ts from "typescript";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { decodeMappings, originalPosition } from "./sourcemap.js";
import { parseFailedTests } from "../executor/checks.js";
const isTestFile = (rel) => /(^|\/)__tests__\/.*\.test\.tsx?$|\.(test|spec)\.tsx?$/.test(rel);
/**
 * The package sources whose functions are instrumented and indexed: TypeScript under src/, tests and declarations
 * excluded. For the repository root as one unit (`nested`: a single package, or a workspace whose one runner config
 * covers every package), any src/ directory below it: packages/<name>/src/... as well as src/....
 */
export const isInstrumented = (relToPackage, nested = false) => (nested ? /(^|\/)src\/.*\.tsx?$/.test(relToPackage) && !relToPackage.includes("node_modules/") : /^src\/.*\.tsx?$/.test(relToPackage)) &&
    !/\.d\.[mc]?ts$/.test(relToPackage) &&
    !isTestFile(relToPackage);
/** Whether a package directory is the repository root, whose sources are found below it at any depth. */
const nestedFor = (packageDir) => packageDir === "." || packageDir === "";
const SKIP_SOURCE_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out"]);
function scriptKind(file) {
    return file.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
function functionsOf(code, file) {
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, scriptKind(file));
    const out = [];
    const visit = (node, depth) => {
        if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
            node.body) {
            const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const end = sf.getLineAndCharacterOfPosition(node.getEnd());
            out.push({ node, body: node.body, depth, span: { id: `${file}#${start.line + 1}:${start.character}`, start: start.line + 1, end: end.line + 1 } });
            ts.forEachChild(node, (child) => visit(child, depth + 1));
            return;
        }
        ts.forEachChild(node, (child) => visit(child, depth));
    };
    visit(sf, 0);
    return out;
}
/** Every function with a body in a source file: its id and 1-based line range. */
export function functionSpans(code, file) {
    return functionsOf(code, file).map((f) => f.span);
}
/**
 * Record a hit at the start of every function: `globalThis.__tiaHit?.(id)` after a block body's `{`, and
 * `(hit, (expr))` around an arrow's expression body. Insertions only (never replacements), so nested functions keep
 * theirs; at one position the outer function's text goes first.
 */
export function instrument(code, file) {
    const edits = [];
    for (const f of functionsOf(code, file)) {
        const hit = `globalThis.__tiaHit?.(${JSON.stringify(f.span.id)})`;
        if (ts.isBlock(f.body))
            edits.push({ pos: f.body.getStart() + 1, text: ` ${hit};`, depth: f.depth });
        else {
            edits.push({ pos: f.body.getStart(), text: `(${hit}, (`, depth: f.depth });
            edits.push({ pos: f.body.getEnd(), text: "))", depth: f.depth });
        }
    }
    // The module itself: marked when its body starts, after any shebang and directive prologue, so a map can tell a
    // file no test loaded in process (code bundled for another runtime, like miniflare's workerd workers) from one
    // whose changed function no test happened to call.
    edits.push({ pos: modulePrologueEnd(code, file), text: `globalThis.__tiaHit?.(${JSON.stringify(`${file}#module`)});`, depth: -1 });
    // Apply from the end; at one position the inner function's text is applied last, so it lands first (innermost).
    edits.sort((a, b) => b.pos - a.pos || a.depth - b.depth);
    let out = code;
    for (const e of edits)
        out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
    return out;
}
/** Where a statement may be inserted at the top of a module: after a shebang line and any directive prologue. */
function modulePrologueEnd(code, file) {
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let pos = code.startsWith("#!") ? code.indexOf("\n") + 1 || code.length : 0;
    for (const st of sf.statements) {
        if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression))
            pos = st.getEnd();
        else
            break;
    }
    return pos;
}
/** The id under which a map records that a test loaded a module. */
export const moduleId = (rel) => `${rel}#module`;
export { readTiaMap, tiaFile, writeTiaMap } from "./records.js";
function sourcesOf(packageDir, nested = false) {
    const out = [];
    const walk = (abs) => {
        for (const name of readdirSync(abs)) {
            if (name === "node_modules" || (nested && (SKIP_SOURCE_DIRS.has(name) || name.startsWith("."))))
                continue;
            const path = join(abs, name);
            const stat = statSync(path);
            if (stat.isDirectory())
                walk(path);
            else {
                const rel = relative(packageDir, path).split("\\").join("/");
                if (isInstrumented(rel, nested))
                    out.push(rel);
            }
        }
    };
    if (nested)
        walk(packageDir);
    else if (existsSync(join(packageDir, "src")))
        walk(join(packageDir, "src"));
    return out.sort();
}
/** The functions of every instrumented source of a package, as the map records them. */
export function indexFunctions(packageDir, nested = false) {
    return Object.fromEntries(sourcesOf(packageDir, nested).map((rel) => [rel, functionSpans(readFileSync(join(packageDir, rel), "utf8"), rel)]));
}
/** Changed line ranges of `git diff -U0` output per file (repo-relative): the base side (`start`, `count`) and the new side. */
export function baseHunks(diff) {
    const out = new Map();
    let file = null;
    for (const line of diff.split("\n")) {
        const header = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line);
        if (header) {
            file = header[1] ?? null;
            continue;
        }
        const plus = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
        if (plus) {
            if (file === null && plus[1])
                file = plus[1]; // added file: no base side
            continue;
        }
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && file) {
            const list = out.get(file) ?? [];
            list.push({ start: Number(hunk[1]), count: hunk[2] === undefined ? 1 : Number(hunk[2]), newStart: Number(hunk[3]), newCount: hunk[4] === undefined ? 1 : Number(hunk[4]) });
            out.set(file, list);
        }
    }
    return out;
}
/** Names of the exported variables at a file's top level (null code: none). */
function exportedVariables(code, file) {
    const out = new Set();
    if (code === null)
        return out;
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const st of sf.statements) {
        if (!ts.isVariableStatement(st) || !(ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
            continue;
        for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name))
                out.add(d.name.text);
    }
    return out;
}
function containsFunction(node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
        return true;
    return ts.forEachChild(node, containsFunction) === true;
}
/**
 * What a change at module scope (outside every function) can affect, from the top-level statements containing the
 * changed lines: "inert" when they are all erased by TypeScript (type aliases, interfaces, `import type`, `declare`)
 * or are blank or comments; "exported" when one is an exported variable, which code anywhere may read; "file"
 * otherwise (an import, a top-level constant or call), which the functions of this file see.
 */
function moduleChange(code, lines, file, existing) {
    if (code === null || lines.length === 0)
        return "inert";
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const spans = sf.statements.map((st) => ({ st, start: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1, end: sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1 }));
    let result = "inert";
    for (const line of lines) {
        const found = spans.find((x) => x.start <= line && line <= x.end);
        if (!found)
            continue;
        const st = found.st;
        const modifiers = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
        const erased = ts.isTypeAliasDeclaration(st) ||
            ts.isInterfaceDeclaration(st) ||
            modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ||
            (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly === true) ||
            (ts.isExportDeclaration(st) && st.isTypeOnly);
        if (erased)
            continue;
        if (ts.isVariableStatement(st) && modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
            // An exported object that carries behavior (a command definition with its handler) is exercised by the tests
            // that run that behavior, through its functions in this file; a plain exported value can be read from anywhere.
            const carriesBehavior = st.declarationList.declarations.some((d) => d.initializer && containsFunction(d.initializer));
            // A value exported for the first time has no reader outside this change, and the new code reading it is in
            // functions the change touches.
            const isNew = existing !== undefined && st.declarationList.declarations.every((d) => ts.isIdentifier(d.name) && !existing.has(d.name.text));
            if (!carriesBehavior && !isNew)
                return "exported";
        }
        result = "file";
    }
    return result;
}
/**
 * What a change to one source file touches, from its hunks and its functions at the base: the innermost functions
 * whose base lines a hunk touches (an insertion counts for the function around its anchor line), and the strongest
 * module-scope effect among the changed statements outside every function (moduleChange).
 */
export function fileChange(spans, fileHunks, rel, read) {
    const touched = new Set();
    const baseOutside = [];
    const newOutside = [];
    const innermost = (fits) => spans.filter(fits).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    for (const h of fileHunks) {
        if (h.count === 0) {
            // An insertion after base line `start` is inside a function only when the lines on both sides of it are.
            const around = innermost((s) => s.start <= h.start && h.start + 1 <= s.end);
            if (around)
                touched.add(around.id);
            else
                for (let i = 0; i < h.newCount; i++)
                    newOutside.push(h.newStart + i);
            continue;
        }
        let outside = false;
        for (let line = h.start; line < h.start + h.count; line++) {
            const around = innermost((s) => s.start <= line && line <= s.end);
            if (around)
                touched.add(around.id);
            else {
                baseOutside.push(line);
                outside = true;
            }
        }
        if (outside)
            for (let i = 0; i < h.newCount; i++)
                newOutside.push(h.newStart + i);
    }
    const baseCode = read(rel, "base");
    const scope = [moduleChange(baseCode, baseOutside, rel), moduleChange(read(rel, "current"), newOutside, rel, exportedVariables(baseCode, rel))];
    return { touched, scope };
}
/** Test files of a dependent beyond this many are not run for a dependency change: the most specific ones are. */
export const MAX_DEPENDENT_TESTS = 40;
const executedCounts = new WeakMap();
/** Per test file of a map, how many functions it executed (fewer: more specific). */
function executedCount(map) {
    let counts = executedCounts.get(map);
    if (!counts) {
        counts = new Map();
        for (const [id, tests] of Object.entries(map.hits))
            if (!id.endsWith("#module"))
                for (const t of tests)
                    counts.set(t, (counts.get(t) ?? 0) + 1);
        executedCounts.set(map, counts);
    }
    return counts;
}
/**
 * The tests of a dependent package D that a change to package P needs, from D's coverage map (which records the
 * functions of P's sources that D's tests executed through P's built bundles, under P's repository-relative paths):
 * D's test files that executed a changed function of P. A module-scope change selects nothing here: every test of D
 * that loads P executes some function of a widely used file (the tenth run selected whole suites of three packages for
 * a change to miniflare's config schema), and P's own tests and D's type check cover it. At most `max` test files per
 * dependent run, the most specific first (those that executed the fewest functions). `spansOf(rel)` gives P's
 * functions of a file at the base (relative to P), `read` its content on either side.
 */
export function selectDependentTests(dMap, pDir, changed, hunks, spansOf, read, max = MAX_DEPENDENT_TESTS) {
    const run = new Set();
    const notes = [];
    const prefix = pDir === "." || pDir === "" ? "" : `${pDir}/`;
    for (const rel of changed) {
        if (isTestFile(rel) || !isInstrumented(rel, nestedFor(pDir)))
            continue;
        if (!dMap.hits[moduleId(`${prefix}${rel}`)])
            continue;
        const spans = spansOf(rel);
        if (!spans)
            continue;
        const { touched } = fileChange(spans, hunks.get(`${prefix}${rel}`) ?? [], rel, read);
        const tests = new Set([...touched].flatMap((id) => dMap.hits[`${prefix}${id}`] ?? []));
        for (const t of tests)
            run.add(t);
        if (tests.size > 0)
            notes.push(`${prefix}${rel}: ${touched.size} changed function(s) executed by ${tests.size} test file(s) of ${dMap.packageDir}`);
    }
    let selected = [...run];
    if (selected.length > max) {
        const counts = executedCount(dMap);
        selected = selected.sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || a.localeCompare(b)).slice(0, max);
        notes.push(`${run.size} test files of ${dMap.packageDir} executed the changed code; the ${max} most specific run`);
    }
    return { run: selected.sort(), notes };
}
/**
 * The tests a change needs, from the base's function coverage:
 * - changed test files;
 * - the test files that executed a function whose base lines a hunk touches (the innermost enclosing function; an
 *   insertion counts for the function around its anchor line);
 * - for a hunk at module scope: nothing when every changed statement is erased by TypeScript, the test files that
 *   executed any function of the file when it is an import or a top-level statement, and `vitest related` for the file
 *   when it changes an exported variable (code anywhere may read it);
 * - a new source file adds nothing by itself: its code runs only through the changed code that imports it;
 * - anything else the map cannot place (not TypeScript under src/) gets `vitest related`.
 * `read(rel, side)` gives a changed file's content on the base or the current side (null when absent).
 */
export function selectTests(map, changed, hunks, packageDir, read = () => null) {
    const run = new Set();
    const related = new Set();
    const notes = [];
    const executedAnyIn = (rel) => new Set((map.functions[rel] ?? []).flatMap((s) => map.hits[s.id] ?? []));
    for (const rel of changed) {
        if (isTestFile(rel)) {
            run.add(rel);
            continue;
        }
        if (!isInstrumented(rel, nestedFor(packageDir))) {
            related.add(rel);
            notes.push(`${rel}: not instrumented source, related tests`);
            continue;
        }
        const spans = map.functions[rel];
        if (!spans) {
            notes.push(`${rel}: new file, exercised through the changed code that imports it`);
            continue;
        }
        if (map.modules && !map.hits[moduleId(rel)]) {
            // No test loaded this file in process: its code runs elsewhere (another runtime, a subprocess) or nowhere the
            // map can see, so coverage cannot place it.
            related.add(rel);
            notes.push(`${rel}: never loaded by a test in process, related tests`);
            continue;
        }
        const fileHunks = hunks.get(packageDir === "." || packageDir === "" ? rel : `${packageDir}/${rel}`) ?? [];
        const { touched, scope } = fileChange(spans, fileHunks, rel, read);
        if (scope.includes("exported")) {
            related.add(rel);
            notes.push(`${rel}: changes an exported variable, related tests`);
            continue;
        }
        const tests = new Set([...touched].flatMap((id) => map.hits[id] ?? []));
        if (scope.includes("file"))
            for (const t of executedAnyIn(rel))
                tests.add(t);
        for (const t of tests)
            run.add(t);
        notes.push(`${rel}: ${touched.size} changed function(s)${scope.includes("file") ? " and a module-scope change" : ""}, ${tests.size} test file(s)`);
    }
    return { run: [...run].sort(), related: [...related].sort(), notes };
}
const decodedMaps = new Map();
function decodedMapOf(bundleAbs) {
    const known = decodedMaps.get(bundleAbs);
    if (known !== undefined)
        return known;
    let result = null;
    try {
        const raw = JSON.parse(readFileSync(`${bundleAbs}.map`, "utf8"));
        if (raw.version === 3 && typeof raw.mappings === "string" && Array.isArray(raw.sources)) {
            const root = raw.sourceRoot ?? "";
            result = { lines: decodeMappings(raw.mappings), sources: raw.sources.map((src) => resolve(dirname(bundleAbs), root, src)) };
        }
    }
    catch {
        result = null;
    }
    decodedMaps.set(bundleAbs, result);
    return result;
}
const BUNDLE_FILE = /\.[cm]?js$/;
/** The workspace source a bundle position comes from, following nested bundles: repository-relative path and 1-based line. */
export function sourceOfBundlePosition(repo, bundleAbs, line0, col, depth = 0) {
    const map = decodedMapOf(bundleAbs);
    if (!map)
        return null;
    const pos = originalPosition(map.lines, line0, col);
    if (!pos)
        return null;
    const src = map.sources[pos.source];
    if (!src)
        return null;
    const rel = relative(repo, src).split("\\").join("/");
    if (rel.startsWith("..") || rel.includes("node_modules/"))
        return null;
    if (BUNDLE_FILE.test(src) && depth < 3 && existsSync(`${src}.map`))
        return sourceOfBundlePosition(repo, src, pos.line, pos.column, depth + 1);
    if (!/\.[cm]?tsx?$/.test(src))
        return null;
    return { rel, line: pos.line + 1 };
}
/** Instrument a bundle: hits for functions that map to workspace sources, and the loads of those sources' modules. */
export function instrumentBundle(code, bundleAbs, repo) {
    const edits = [];
    const sources = new Set();
    const sf = ts.createSourceFile(bundleAbs, code, ts.ScriptTarget.Latest, true, scriptKind(bundleAbs));
    for (const f of functionsOf(code, bundleAbs)) {
        const at = sf.getLineAndCharacterOfPosition(f.node.getStart(sf));
        const src = sourceOfBundlePosition(repo, bundleAbs, at.line, at.character);
        if (!src)
            continue;
        sources.add(src.rel);
        const hit = `globalThis.__tiaHit?.(${JSON.stringify(`${src.rel}@${src.line}`)})`;
        if (ts.isBlock(f.body))
            edits.push({ pos: f.body.getStart() + 1, text: ` ${hit};`, depth: f.depth });
        else {
            edits.push({ pos: f.body.getStart(), text: `(${hit}, (`, depth: f.depth });
            edits.push({ pos: f.body.getEnd(), text: "))", depth: f.depth });
        }
    }
    if (edits.length === 0)
        return { code, functions: 0, sources: [] };
    const loads = JSON.stringify([...sources].sort().map((rel) => moduleId(rel)));
    edits.push({ pos: modulePrologueEnd(code, bundleAbs), text: `for (const __tiaId of ${loads}) globalThis.__tiaHit?.(__tiaId);`, depth: -1 });
    edits.sort((a, b) => b.pos - a.pos || a.depth - b.depth);
    let out = code;
    for (const e of edits)
        out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
    return { code: out, functions: edits.length - 1, sources: [...sources].sort() };
}
/** Built bundles with source maps under a package's dist/ (absolute paths). */
export function bundlesOf(packageAbs) {
    const out = [];
    const walk = (dir) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const path = join(dir, name);
            let stat;
            try {
                stat = statSync(path);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                if (name !== "node_modules")
                    walk(path);
            }
            else if (BUNDLE_FILE.test(name) && existsSync(`${path}.map`))
                out.push(path);
        }
    };
    walk(join(packageAbs, "dist"));
    return out.sort();
}
const ORIGINAL_SUFFIX = ".commons-tia-orig";
/** Put back bundles an interrupted coverage run left instrumented. */
export function restoreBundles(packageAbs) {
    let restored = 0;
    const walk = (dir) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const path = join(dir, name);
            if (name.endsWith(ORIGINAL_SUFFIX)) {
                renameSync(path, path.slice(0, -ORIGINAL_SUFFIX.length));
                restored++;
            }
            else if (statSync(path).isDirectory() && name !== "node_modules")
                walk(path);
        }
    };
    walk(join(packageAbs, "dist"));
    return restored;
}
/** Instrument bundles in place, keeping the originals beside them; returns a function that restores them. */
export function instrumentBundlesOnDisk(repo, bundles, log) {
    const done = [];
    let functions = 0;
    for (const file of bundles) {
        try {
            const r = instrumentBundle(readFileSync(file, "utf8"), file, repo);
            if (r.functions === 0)
                continue;
            renameSync(file, `${file}${ORIGINAL_SUFFIX}`);
            done.push(file);
            writeFileSync(file, r.code);
            functions += r.functions;
        }
        catch (error) {
            log?.(`bundle ${relative(repo, file)} not instrumented: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    log?.(`instrumented ${done.length} bundle(s), ${functions} function(s) mapped to workspace sources`);
    return () => {
        for (const file of done) {
            try {
                renameSync(`${file}${ORIGINAL_SUFFIX}`, file);
            }
            catch (error) {
                log?.(`restoring ${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    };
}
/**
 * Turn bundle hits (`<repo-relative source>@<line>`) into function ids: the innermost function of that source at the
 * base containing the line. Sources of the package itself get its own ids (relative to it); others keep their
 * repository-relative path. Module loads are renamed the same way. Ids that resolve to no function are dropped.
 */
export function resolveBundleHits(repo, packageDir, hits) {
    const prefix = packageDir === "." || packageDir === "" ? "" : `${packageDir}/`;
    const own = (rel) => (prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : prefix ? null : rel);
    const spans = new Map();
    const spansOf = (rel) => {
        if (!spans.has(rel)) {
            try {
                const local = own(rel);
                spans.set(rel, functionSpans(readFileSync(join(repo, rel), "utf8"), local ?? rel));
            }
            catch {
                spans.set(rel, null);
            }
        }
        return spans.get(rel);
    };
    const out = {};
    const add = (id, tests) => {
        const list = (out[id] ??= []);
        for (const t of tests)
            list.push(t);
    };
    for (const [id, tests] of Object.entries(hits)) {
        const at = id.lastIndexOf("@");
        if (id.endsWith("#module")) {
            const rel = id.slice(0, -"#module".length);
            const local = own(rel);
            add(moduleId(local ?? rel), tests);
            continue;
        }
        if (at < 0 || id.includes("#")) {
            add(id, tests);
            continue;
        }
        const rel = id.slice(0, at);
        const line = Number(id.slice(at + 1));
        const fns = spansOf(rel);
        if (!fns)
            continue;
        const span = fns.filter((s) => s.start <= line && line <= s.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
        // Spans were computed under the package-relative path for its own sources and the repository-relative one otherwise.
        if (span)
            add(span.id, tests);
    }
    for (const id of Object.keys(out))
        out[id] = [...new Set(out[id])].sort();
    return out;
}
/** A vitest config that extends the package's with the instrumenting plugin and the recording setup file. */
export function tiaConfigSource(o) {
    return `import { mergeConfig } from "vitest/config";
import base from ${JSON.stringify(o.baseConfig)};
import { instrument, isInstrumented } from ${JSON.stringify(o.tiaModule)};
const pkg = ${JSON.stringify(o.packageDir)};
const nested = ${JSON.stringify(o.nested === true)};
const resolved = typeof base === "function" ? await base({ command: "serve", mode: "test" }) : base;
// mergeConfig concatenates setupFiles: the package's own setup runs once, then ours.
export default mergeConfig(resolved, {
  plugins: [{
    name: "commons-tia",
    enforce: "pre",
    transform(code, id) {
      if (id.includes("?") || !id.startsWith(pkg + "/")) return null;
      const rel = id.slice(pkg.length + 1);
      if (!isInstrumented(rel, nested)) return null;
      return { code: instrument(code, rel), map: null };
    },
  }],
  test: { setupFiles: [${JSON.stringify(o.setupFile)}] },
});
`;
}
/** Records, per test file, the functions it executed (appended as JSON lines to TIA_OUT). */
export const TIA_SETUP_SOURCE = `import { afterAll, expect } from "vitest";
import { appendFileSync } from "node:fs";
const hits = new Set();
globalThis.__tiaHit = (id) => { hits.add(id); };
afterAll(() => {
  const state = expect.getState();
  const test = state.testPath ?? globalThis.__vitest_worker__?.filepath ?? "unknown";
  appendFileSync(process.env.TIA_OUT, JSON.stringify({ test, hits: [...hits] }) + "\\n");
});
`;
/**
 * Build a package's coverage map on the prepared base: run its whole suite once under the instrumenting config and
 * record which test file executed which function. `runVitest` runs vitest in the package with extra arguments and env.
 */
export async function buildTiaMap(o) {
    const pkgAbs = join(o.repo, o.packageDir);
    const baseConfig = ["vitest.config.mts", "vitest.config.ts", "vitest.config.mjs", "vitest.config.js"].map((f) => join(pkgAbs, f)).find((f) => existsSync(f));
    if (!baseConfig) {
        o.log?.(`no vitest config in ${o.packageDir}; no coverage map`);
        return null;
    }
    mkdirSync(o.workDir, { recursive: true });
    // Inside the package, so that `vitest` resolves from them; removed after the run.
    const setupFile = join(pkgAbs, ".commons-tia.setup.mjs");
    const config = join(pkgAbs, ".commons-tia.vitest.config.mts");
    const out = join(o.workDir, "hits.jsonl");
    writeFileSync(setupFile, TIA_SETUP_SOURCE);
    writeFileSync(config, tiaConfigSource({ packageDir: pkgAbs, baseConfig, tiaModule: o.tiaModule, setupFile, nested: nestedFor(o.packageDir) }));
    writeFileSync(out, "");
    const started = Date.now();
    let r;
    const restore = o.bundles?.length ? instrumentBundlesOnDisk(o.repo, o.bundles, o.log) : () => undefined;
    try {
        r = await o.runVitest(["--config", config, "--root", pkgAbs, "--passWithNoTests"], { TIA_OUT: out });
    }
    finally {
        restore();
        rmSync(setupFile, { force: true });
        rmSync(config, { force: true });
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const hits = {};
    const tests = new Set();
    for (const line of readFileSync(out, "utf8").split("\n")) {
        if (!line.trim())
            continue;
        let rec;
        try {
            rec = JSON.parse(line);
        }
        catch {
            continue;
        }
        const test = relative(pkgAbs, rec.test).split("\\").join("/");
        tests.add(test);
        for (const id of rec.hits)
            (hits[id] ??= []).push(test);
    }
    if (tests.size === 0) {
        o.log?.(`coverage run of ${o.packageDir} recorded nothing (exit ${r.code} after ${seconds} s): ${`${r.stdout}\n${r.stderr}`.slice(-1500)}`);
        return null;
    }
    for (const id of Object.keys(hits))
        hits[id] = [...new Set(hits[id])].sort();
    const resolved = o.bundles?.length ? resolveBundleHits(o.repo, o.packageDir, hits) : hits;
    // Tests that fail on the base itself: a later check does not hold their failure against a change.
    const baseFailures = r.code === 0 ? [] : parseFailedTests(r.stdout, r.stderr);
    const map = { root: o.root, packageDir: o.packageDir, builtAt: new Date().toISOString(), functions: indexFunctions(pkgAbs, nestedFor(o.packageDir)), hits: resolved, tests: [...tests].sort(), modules: true, ...(baseFailures.length ? { baseFailures } : {}), suiteMs: seconds * 1000 };
    o.log?.(`coverage map of ${o.packageDir}: ${tests.size} test files, ${Object.keys(map.hits).filter((id) => !id.includes("/") || !id.startsWith("packages/")).length} executed functions and modules (${Object.keys(map.hits).length} with other packages') of ${Object.values(map.functions).reduce((n, f) => n + f.length, 0)}, built in ${seconds} s (suite exit ${r.code})`);
    return map;
}
//# sourceMappingURL=tia.js.map