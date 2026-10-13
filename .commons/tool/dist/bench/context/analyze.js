// Candidate analysis for the context-option migration workload: date-fns v3.6.0 -> v4.1.0 added an `in` context
// option (ContextOptions / DateArg) to every function. For each function that exists in both versions, decide whether
// its change is context-only (so the v4.1 doc comment and signature are a sufficient spec), record which other
// functions its v4.1 implementation imports (dependencies between tasks), and validate fail-to-pass: with the function
// reverted to v3.6 the hidden v4.1 test must fail, and the reverted function's own v3.6 test must pass.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { git } from "../../executor/git.js";
import { linkNodeModules } from "../rhf/prepare.js";
import { parseVitestJson } from "../scale/official.js";
const run = promisify(execFile);
export const OLD_TAG = "v3.6.0";
export const NEW_TAG = "v4.1.0";
const NOT_FUNCTIONS = new Set(["fp", "locale", "_lib", "constants", "types", "parse", "format", "formatters"]);
/** Shared by the whole migration and already present in the base: never a task, never a dependency. */
export const SHARED = new Set(["toDate", "constructFrom", "constructNow"]);
const ALLOWED_REMOVED = [
    /^import\b/,
    /^export (function|interface|type) /,
    /^(export )?interface \w+/,
    /^\w+<\w+ extends Date>\($/,
    /^[{}()<>,;:\s]*$/,
    /^\): .*\{?$/,
    /^[\w$]+\??: [^=]+,?$/, // a parameter or interface member line
    /\btoDate\(/,
    /\bconstructFrom\(/,
    /\bnew Date\(/,
    /\.constructor\(/,
    /\bDateType\b/,
    /^\* /,
    /^\*$/,
    /^\/\*\*$/,
    /^\*\/$/,
    /^\/\//,
];
function codeLines(text) {
    return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
}
/** A line with the context plumbing removed, so an old line and its migrated form compare equal. */
export function stripPlumbing(line) {
    return line
        .replace(/options\?\.in\s*\|\|\s*/g, "")
        .replace(/,?\s*\boptions\?\.in\b/g, "")
        .replace(/,?\s*\{\s*in:\s*options\?\.in\s*\}/g, "")
        .replace(/,?\s*\boptions\b(?!:)/g, "")
        .replace(/\bDateArg<(\w+)>/g, "$1 | number | string")
        .replace(/\bResultDate\b/g, "DateType")
        .replace(/[\s,;]+/g, " ")
        .trim();
}
/**
 * Context-only when every removed line is a signature, import, type, comment, or construction line, or reappears in
 * the new source once the context plumbing (`options`, `options?.in`, `DateArg`, `ResultDate`) is stripped.
 */
export function classifyDiff(oldSource, newSource) {
    const after = new Set(codeLines(newSource));
    const afterStripped = new Set(codeLines(newSource).map(stripPlumbing));
    const removed = codeLines(oldSource).filter((l) => !after.has(l));
    const other = removed.filter((l) => !ALLOWED_REMOVED.some((re) => re.test(l)) && !afterStripped.has(stripPlumbing(l)));
    return { contextOnly: other.length === 0, otherRemovedLines: other };
}
export function functionImports(source) {
    const out = new Set();
    for (const m of source.matchAll(/from\s+["']\.\.\/([^/"']+)\/index\.js["']/g)) {
        if (!NOT_FUNCTIONS.has(m[1]) && !SHARED.has(m[1]) && !m[1].startsWith("_"))
            out.add(m[1]);
    }
    return [...out].sort();
}
async function show(repo, rev, path) {
    try {
        const { stdout } = await run("git", ["-C", repo, "show", `${rev}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
        return stdout;
    }
    catch {
        return null;
    }
}
async function vitest(cwd, file, reportPath) {
    await rm(reportPath, { force: true });
    let code = 0;
    try {
        await run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, file], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000 });
    }
    catch (error) {
        const e = error;
        code = typeof e.code === "number" ? e.code : 1;
    }
    const fn = file.split("/")[1];
    try {
        const parsed = parseVitestJson(JSON.parse(await readFile(reportPath, "utf8")), [fn]).get(fn);
        return { code, names: parsed.failedNames.length ? parsed.failedNames : parsed.error ? [parsed.error] : [], passed: parsed.passed && code === 0 };
    }
    catch {
        return { code, names: ["no report"], passed: false };
    }
}
/** Hidden test names that the context migration adds: the `context` describe block and the result-type tests. */
export function isContextTest(name) {
    return /\bcontext\b/i.test(name) || /resolves the (date|argument|context date) type/i.test(name) || /normalizes the dates/i.test(name);
}
export function isEligible(c) {
    if (SHARED.has(c.name))
        return false;
    const contextOnly = c.hiddenFailedNames ? c.hiddenFailedNames.length > 0 && c.hiddenFailedNames.every(isContextTest) : c.hiddenContextOnly === true;
    return c.referenceGreen === true && c.baseGreen === true && c.hiddenFailsOnBase === true && contextOnly;
}
export async function analyzeContextMigration(o) {
    const log = o.log ?? ((l) => console.error(`[context] ${l}`));
    const src = join(o.repo, "src");
    const names = readdirSync(src, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !NOT_FUNCTIONS.has(e.name) && !SHARED.has(e.name) && !e.name.startsWith("_"))
        .map((e) => e.name)
        .filter((n) => existsSync(join(src, n, "index.ts")) && existsSync(join(src, n, "test.ts")))
        .sort();
    const candidates = [];
    for (const name of names) {
        const oldIndex = await show(o.repo, OLD_TAG, `src/${name}/index.ts`);
        const oldTest = await show(o.repo, OLD_TAG, `src/${name}/test.ts`);
        if (oldIndex === null || oldTest === null)
            continue;
        const newIndex = await readFile(join(src, name, "index.ts"), "utf8");
        if (oldIndex === newIndex)
            continue;
        const { contextOnly, otherRemovedLines } = classifyDiff(oldIndex, newIndex);
        candidates.push({ name, contextOnly, otherRemovedLines, importsInNew: functionImports(newIndex), oldCodeLines: codeLines(oldIndex).length, newCodeLines: codeLines(newIndex).length });
    }
    log(`${candidates.length} functions changed between ${OLD_TAG} and ${NEW_TAG}; ${candidates.filter((c) => c.contextOnly).length} context-only`);
    await mkdir(o.out, { recursive: true });
    const outFile = join(o.out, "context-analysis.json");
    // Resume: keep validation results already recorded for unchanged candidates.
    if (existsSync(outFile)) {
        const previous = new Map(JSON.parse(await readFile(outFile, "utf8")).map((c) => [c.name, c]));
        for (const c of candidates) {
            const p = previous.get(c.name);
            if (p && p.referenceGreen !== undefined && p.contextOnly === c.contextOnly) {
                const names = p.hiddenFailedNames ?? [];
                Object.assign(c, { referenceGreen: p.referenceGreen, baseGreen: p.baseGreen, hiddenFailsOnBase: p.hiddenFailsOnBase, hiddenFailedNames: names, hiddenContextOnly: names.length > 0 && names.every(isContextTest) });
            }
        }
    }
    await writeFile(outFile, JSON.stringify(candidates, null, 1));
    if (o.validate === false)
        return candidates;
    const probe = join(o.out, "context-probe");
    if (!existsSync(join(probe, ".git"))) {
        await run("git", ["-C", o.repo, "worktree", "add", "--detach", "-q", probe, NEW_TAG]);
    }
    await git(probe, ["checkout", "-q", "--", "src"]);
    await linkNodeModules(join(o.repo, "node_modules"), probe);
    const report = join(o.out, "context-probe.json");
    let i = 0;
    for (const c of candidates) {
        i++;
        if (c.referenceGreen !== undefined)
            continue;
        const oldIndex = (await show(o.repo, OLD_TAG, `src/${c.name}/index.ts`));
        const oldTest = (await show(o.repo, OLD_TAG, `src/${c.name}/test.ts`));
        const file = `src/${c.name}/test.ts`;
        try {
            const reference = await vitest(probe, file, report);
            c.referenceGreen = reference.passed;
            await writeFile(join(probe, "src", c.name, "index.ts"), oldIndex);
            await writeFile(join(probe, "src", c.name, "test.ts"), oldTest);
            const base = await vitest(probe, file, report);
            c.baseGreen = base.passed;
            await git(probe, ["checkout", "-q", "--", `src/${c.name}/test.ts`]);
            const hidden = await vitest(probe, file, report);
            c.hiddenFailsOnBase = !hidden.passed;
            c.hiddenFailedNames = hidden.names;
            c.hiddenContextOnly = hidden.names.length > 0 && hidden.names.every(isContextTest);
        }
        finally {
            await git(probe, ["checkout", "-q", "--", `src/${c.name}`]);
        }
        log(`${i}/${candidates.length} ${c.name}: reference ${c.referenceGreen ? "green" : "RED"}, base ${c.baseGreen ? "green" : "RED"}, hidden ${c.hiddenFailsOnBase ? "fails on base" : "PASSES on base"} (${c.hiddenFailedNames?.length ?? 0} failures)`);
        await writeFile(outFile, JSON.stringify(candidates, null, 1));
    }
    const eligible = candidates.filter(isEligible);
    log(`eligible: ${eligible.length} (${eligible.map((c) => c.name).join(" ")})`);
    return candidates;
}
//# sourceMappingURL=analyze.js.map