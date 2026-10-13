// Coverage-guided context for a task brief: from the task's text to the code it most likely needs.
//
// The issue text is reduced to weighted terms (code spans, identifiers, flags, command words). Test files are scored
// by those terms (their path, their test titles, the identifiers they use), weighted by how rare each term is across
// the suite. Where the base recorded a function-coverage map (tia.ts), the best tests vote for the functions they
// executed, each vote weighted by how specific the function is (executed by few test files: a command's handler, not
// the CLI bootstrap every test runs). Source files are also scored by their own path and declared names, which is all
// there is without a map. The result is a short list of files with their most likely functions and the tests that
// exercise them, for the agent to read first instead of searching.
import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { packageDirs } from "./check.js";
import { nearestBase, readTiaMap } from "./records.js";
import { packageDirIn } from "./workspace.js";
const STOP = new Set("the a an and or but if then else when while for with without from into onto this that these those there here what which who whom whose how why where is are was were be been being do does did done have has had having not no yes can could should would will shall may might must it its it's i we you they he she them our your their my me us of on in at by to as up out over under about after before again also any all some each every more most other such only own same so than too very just get got make made use used using new old true false null undefined error errors issue bug fix fixes fixed version versions expected actual behavior behaviour reproduce steps run running works working work like see seems seem please thanks via e.g eg etc one two way case cases".split(" "));
/** Split an identifier into its lowercase words: `parseQueueMessage` -> parse, queue, message. */
function wordsOf(identifier) {
    return identifier
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}
/** Weighted terms of a task's text: words of code spans, identifiers and flags count three times as much as prose. */
export function termsOf(text) {
    const terms = new Map();
    const add = (word, weight) => terms.set(word, Math.max(terms.get(word) ?? 0, weight));
    for (const m of text.matchAll(/`([^`\n]{1,120})`/g))
        for (const w of wordsOf(m[1]))
            add(w, 3);
    for (const m of text.matchAll(/--?[a-z][a-z0-9-]{2,}/g))
        for (const w of wordsOf(m[0]))
            add(w, 3);
    for (const m of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:[A-Z_.][A-Za-z0-9_$]+)+\b/g))
        for (const w of wordsOf(m[0]))
            add(w, 2);
    for (const w of wordsOf(text))
        add(w, 1);
    return terms;
}
/** Titles of `describe`/`it`/`test` blocks in a test file. */
export function testTitles(source) {
    return [...source.matchAll(/\b(?:describe|it|test)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1).){1,200})\1/g)].map((m) => m[2]);
}
function bagOf(text) {
    return new Set(wordsOf(text));
}
/** The functions of a source file with a name: declarations, methods, and functions assigned to a name or property. */
export function namedFunctions(code, file) {
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out = [];
    const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const visit = (node) => {
        let name;
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name)
            name = node.name.getText(sf);
        else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
            const p = node.parent;
            if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name))
                name = p.name.text;
            else if (ts.isPropertyAssignment(p))
                name = p.name.getText(sf);
        }
        if (name)
            out.push({ name, start: line(node.getStart(sf)), end: line(node.getEnd()) });
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}
function walk(dir, accept, root = dir, out = []) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return out;
    }
    for (const name of names) {
        if (name === "node_modules" || name === "dist" || name.startsWith("."))
            continue;
        const path = join(dir, name);
        let stat;
        try {
            stat = statSync(path);
        }
        catch {
            continue;
        }
        if (stat.isDirectory())
            walk(path, accept, root, out);
        else {
            const rel = relative(root, path).split("\\").join("/");
            if (accept(rel))
                out.push(rel);
        }
    }
    return out;
}
/**
 * How much a file's own words count against the tests' coverage vote. Measured on the twenty-five workers-sdk issues
 * (is a file the real fix changed among the hints?): with the maps that record only a package's own functions, words
 * alone ranked one first for 12 and in the top six for 18, coverage alone 3 and 8; with the maps that also record
 * dependencies' functions and module loads (whose votes are left out), three to one ranks one first for 9, in the top
 * three for 15 and in the top six for 19, and weights from 2 to 6 differ by one task at most.
 */
const LEXICAL_WEIGHT = 3;
const TEST_FILE = /(^|\/)__tests__\/.*\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** Relative imports of a file resolved to files of `known` (extension and index lookups), relative to the package. */
function importsOf(code, from, known) {
    const out = [];
    const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    for (const m of code.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*|vi\.mock\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        const parts = [...(dir ? dir.split("/") : []), ...m[1].split("/")];
        const stack = [];
        for (const p of parts) {
            if (p === "." || p === "")
                continue;
            if (p === "..")
                stack.pop();
            else
                stack.push(p);
        }
        const target = stack.join("/").replace(/\.[cm]?js$/, "");
        for (const candidate of [target, ...[".ts", ".tsx", ".mts", ".js", ".mjs"].map((e) => target + e), ...["/index.ts", "/index.tsx", "/index.js"].map((e) => target + e)]) {
            if (known.has(candidate)) {
                out.push(candidate);
                break;
            }
        }
    }
    return out;
}
/** Top-level declared names of a source file (functions, classes, variables, types), for lexical matching. */
function declaredNames(code) {
    return [...code.matchAll(/\b(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]);
}
/**
 * The files a task most likely needs, best first. `packageDir` is absolute; files are relative to it. `map` is the
 * package's function-coverage map at the base, or null: then the tests' relative imports stand in for coverage.
 */
export function coverageHints(o) {
    const terms = termsOf(o.text);
    if (terms.size === 0)
        return [];
    const read = (rel) => {
        try {
            return readFileSync(join(o.packageDir, rel), "utf8");
        }
        catch {
            return "";
        }
    };
    const sources = o.map ? Object.keys(o.map.functions) : walk(o.packageDir, (rel) => SOURCE_FILE.test(rel) && !TEST_FILE.test(rel) && !rel.endsWith(".d.ts"));
    const sourceSet = new Set(sources);
    const tests = o.map?.tests ?? walk(o.packageDir, (rel) => TEST_FILE.test(rel));
    const testCode = new Map(tests.map((t) => [t, read(t)]));
    // Test files scored by the task's terms (path, titles), weighted by rarity across the suite.
    const testBags = new Map(tests.map((t) => [t, new Set([...bagOf(t), ...testTitles(testCode.get(t)).flatMap((x) => [...bagOf(x)])])]));
    const df = new Map();
    for (const bag of testBags.values())
        for (const w of bag)
            if (terms.has(w))
                df.set(w, (df.get(w) ?? 0) + 1);
    const idf = (w) => Math.log(1 + tests.length / (1 + (df.get(w) ?? 0)));
    const testScore = new Map();
    for (const [t, bag] of testBags) {
        let score = 0;
        for (const [w, weight] of terms)
            if (bag.has(w))
                score += weight * idf(w);
        if (score > 0)
            testScore.set(t, score);
    }
    const topTests = [...testScore].sort((a, b) => b[1] - a[1]).slice(0, o.maxTests ?? 8);
    // Coverage: what the best tests executed (the map), or imported (no map), each weighted by its specificity.
    const covered = new Map();
    const fnScore = new Map();
    const fileTests = new Map();
    // Per test file, how many functions it executed: a test that runs everything (a CLI smoke test) is not "the test of" a file.
    const executedBy = new Map();
    const credit = (file, test, amount) => {
        covered.set(file, (covered.get(file) ?? 0) + amount);
        const set = fileTests.get(file) ?? new Set();
        set.add(test);
        fileTests.set(file, set);
    };
    if (o.map) {
        const byTest = new Map();
        // Only this package's functions: maps also record module loads and other packages' functions (cross-package coverage).
        const own = (id) => !id.endsWith("#module") && Object.prototype.hasOwnProperty.call(o.map.functions, id.slice(0, id.indexOf("#")));
        for (const [id, hitBy] of Object.entries(o.map.hits))
            if (own(id))
                for (const t of hitBy)
                    byTest.set(t, [...(byTest.get(t) ?? []), id]);
        for (const [t, ids] of byTest)
            executedBy.set(t, ids.length);
        const total = o.map.tests.length;
        for (const [t, score] of topTests) {
            for (const id of byTest.get(t) ?? []) {
                const specificity = Math.log(1 + total / (o.map.hits[id]?.length ?? total));
                fnScore.set(id, (fnScore.get(id) ?? 0) + score * specificity);
                credit(id.slice(0, id.indexOf("#")), t, score * specificity);
            }
        }
        for (const [file, score] of covered)
            covered.set(file, score / Math.sqrt(o.map.functions[file]?.length ?? 1));
    }
    else {
        const importers = new Map();
        const imports = new Map(tests.map((t) => [t, importsOf(testCode.get(t), t, sourceSet)]));
        for (const list of imports.values())
            for (const f of new Set(list))
                importers.set(f, (importers.get(f) ?? 0) + 1);
        for (const [t, score] of topTests)
            for (const f of new Set(imports.get(t) ?? []))
                credit(f, t, score * Math.log(1 + tests.length / (importers.get(f) ?? 1)));
    }
    // Lexical: the source's path words and declared names, weighted by rarity across the sources.
    const sourceBags = new Map(sources.map((f) => [f, new Set([...bagOf(f), ...declaredNames(read(f)).flatMap((n) => wordsOf(n))])]));
    const sdf = new Map();
    for (const bag of sourceBags.values())
        for (const w of bag)
            if (terms.has(w))
                sdf.set(w, (sdf.get(w) ?? 0) + 1);
    const sidf = (w) => Math.log(1 + sources.length / (1 + (sdf.get(w) ?? 0)));
    const lexical = new Map();
    for (const [f, bag] of sourceBags) {
        let score = 0;
        for (const [w, weight] of terms)
            if (bag.has(w))
                score += weight * sidf(w) * (bagOf(f).has(w) ? 2 : 1);
        if (score > 0)
            lexical.set(f, score);
    }
    const maxCovered = Math.max(1e-9, ...covered.values());
    const maxLexical = Math.max(1e-9, ...lexical.values());
    const fileScore = new Map();
    for (const f of new Set([...covered.keys(), ...lexical.keys()]))
        fileScore.set(f, (covered.get(f) ?? 0) / maxCovered + (LEXICAL_WEIGHT * (lexical.get(f) ?? 0)) / maxLexical);
    const ranked = [...fileScore].sort((a, b) => b[1] - a[1]).slice(0, o.maxFiles ?? 6);
    const GENERIC = new Set(["index", "src", "test", "tests", "spec", "utils", "util", "helpers", "lib", "types", "worker", "workers", "main", "shared", "core"]);
    const nameWords = (path) => new Set(wordsOf(path.split("/").slice(-2).join(" ").replace(/\.(test|spec)\./, ".")).filter((w) => !GENERIC.has(w)));
    /** The tests to name for a file: those named after it first, then the most specific of the best tests that ran it. */
    const testsOfFile = (file) => {
        const words = nameWords(file.replace(/\.[cm]?[jt]sx?$/, ""));
        const named = tests
            .map((t) => ({ t, overlap: [...nameWords(t)].filter((w) => words.has(w)).length }))
            .filter((x) => x.overlap > 0)
            .sort((a, b) => b.overlap - a.overlap || a.t.length - b.t.length)
            .map((x) => x.t);
        const covering = [...(fileTests.get(file) ?? [])].sort((a, b) => (testScore.get(b) ?? 0) / Math.sqrt(executedBy.get(b) ?? 1) - (testScore.get(a) ?? 0) / Math.sqrt(executedBy.get(a) ?? 1));
        return [...new Set([...named.slice(0, 2), ...covering])].slice(0, 3);
    };
    return ranked.map(([file, score]) => {
        const code = read(file);
        let functions = [];
        if (code && /\.[cm]?tsx?$|\.[cm]?jsx?$/.test(file)) {
            const named = namedFunctions(code, file);
            const spans = o.map?.functions[file] ?? [];
            const scored = spans
                .map((s) => ({ s, score: fnScore.get(s.id) ?? 0 }))
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 4)
                .map(({ s }) => {
                const n = named.filter((f) => f.start <= s.start && s.end <= f.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
                return { name: n?.name ?? "(anonymous)", line: s.start };
            });
            functions = scored.length > 0 ? scored : named.filter((f) => [...bagOf(f.name)].some((w) => terms.has(w))).slice(0, 4).map((f) => ({ name: f.name, line: f.start }));
        }
        return { file, score, functions, tests: testsOfFile(file) };
    });
}
/** The hints as a brief section. `prefix` is prepended to file paths (the package directory, from the repository root). */
export function renderHints(hints, prefix = "") {
    if (hints.length === 0)
        return "";
    const lines = ["## Where to look first", "From the task's words and the tests that exercise them on the base (a starting point, not a boundary):"];
    for (const h of hints) {
        const fns = h.functions.map((f) => `${f.name} (line ${f.line})`).join(", ");
        lines.push(`- ${prefix}${h.file}${fns ? `: ${fns}` : ""}${h.tests.length ? `; tested by ${h.tests.map((t) => `${prefix}${t}`).join(", ")}` : ""}`);
    }
    return lines.join("\n");
}
export function packageHints(repo, packageDir, text, map, maxFiles = 6) {
    const abs = join(repo, packageDir);
    if (!existsSync(abs))
        return "";
    return renderHints(coverageHints({ packageDir: abs, text, map, maxFiles }), packageDir === "." ? "" : `${packageDir}/`);
}
/**
 * The "where to look first" section for a task: for each workspace package its write scope touches (or the root of a
 * single-package repository), hints from the task's title and body and that package's coverage map at the nearest
 * recorded base. Empty when nothing scores.
 */
export function taskHints(repo, task, opts = {}) {
    if (process.env.COMMONS_HINTS === "0")
        return "";
    const dirs = packageDirs(repo);
    const packages = [...new Set(task.writes.map((w) => packageDirIn(w.path.replace(/\/$/, "") + "/", dirs)).filter((d) => d !== null))];
    if (packages.length === 0 && dirs.includes("."))
        packages.push(".");
    const base = nearestBase(repo, opts.recordsDir) ?? null;
    const text = `${task.title}\n\n${task.body}`;
    const sections = [];
    for (const dir of packages.slice(0, 3)) {
        const map = base ? readTiaMap(base, dir, opts.recordsDir) : null;
        const section = packageHints(repo, dir, text, map, opts.maxFiles ?? 6);
        if (section)
            sections.push(section);
    }
    return sections.join("\n\n");
}
//# sourceMappingURL=hints.js.map