// The scale workload: date-fns v4.1.0 with K leaf functions removed. Each task re-implements one function from its
// original doc comment and signature; the hidden tests are the original test files plus a barrel-export check.
// Contention is real but modest: every task adds one line to the generated barrel `src/index.ts`.
import { execFile } from "node:child_process";
import { benchRoot } from "../issues/prepare.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { git } from "../../executor/git.js";
import { linkNodeModules } from "../rhf/prepare.js";
const run = promisify(execFile);
export const SCALE_REPO_URL = "https://github.com/date-fns/date-fns.git";
export const SCALE_TAG = "v4.1.0";
export const SCALE_COMMIT = "313b902b9a72c64501074db9bc2b9897d2db5140";
/** Directories under src/ that are not functions. */
const NOT_FUNCTIONS = new Set(["fp", "locale", "_lib", "constants", "types"]);
export const MIN_CODE_LINES = 8;
export const MIN_TESTS = 4;
const SOURCE_EXT = /\.(ts|mts|js|mjs)$/;
function walk(dir, skip, out = []) {
    if (!existsSync(dir))
        return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip(entry.name))
            continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory())
            walk(p, skip, out);
        else if (SOURCE_EXT.test(entry.name) && !entry.name.endsWith(".d.ts"))
            out.push(p);
    }
    return out;
}
/** Non-comment, non-blank lines. */
export function codeLineCount(source) {
    return source.split("\n").filter((l) => l.trim() !== "" && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
}
export function testCount(source) {
    return (source.match(/\bit\(/g) ?? []).length;
}
/**
 * Functions under `repo/src` with an index.ts and a test.ts that no other source file imports (fp wrappers and the
 * barrel excluded) and that nothing under `test/` or `scripts/` references. Removing one leaves the suite green.
 */
export function leafFunctions(repo) {
    const src = join(repo, "src");
    const names = readdirSync(src, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !NOT_FUNCTIONS.has(e.name))
        .map((e) => e.name)
        .filter((n) => existsSync(join(src, n, "index.ts")) && existsSync(join(src, n, "test.ts")))
        .sort();
    const nameSet = new Set(names);
    const importers = new Map();
    for (const file of walk(src, (n) => n === "fp" || n === "node_modules")) {
        const rel = file.slice(repo.length + 1).split("\\").join("/");
        if (rel === "src/index.ts")
            continue;
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
            const target = resolve(join(file, "..", m[1])).slice(repo.length + 1).split("\\").join("/");
            const mm = /^src\/([^/]+)\//.exec(target);
            if (!mm || !nameSet.has(mm[1]))
                continue;
            if (rel.startsWith(`src/${mm[1]}/`))
                continue;
            let set = importers.get(mm[1]);
            if (!set)
                importers.set(mm[1], (set = new Set()));
            set.add(rel);
        }
    }
    const external = [...walk(join(repo, "test"), (n) => n === "node_modules"), ...walk(join(repo, "scripts"), (n) => n === "node_modules")].map((file) => ({ rel: file.slice(repo.length + 1).split("\\").join("/"), text: readFileSync(file, "utf8") }));
    return names
        .map((name) => ({
        name,
        codeLines: codeLineCount(readFileSync(join(src, name, "index.ts"), "utf8")),
        tests: testCount(readFileSync(join(src, name, "test.ts"), "utf8")),
        importers: [...(importers.get(name) ?? [])].sort(),
        externalRefs: external.filter((f) => f.text.includes(`/${name}/`)).map((f) => f.rel),
    }))
        .filter((f) => f.importers.length === 0 && f.externalRefs.length === 0);
}
export function eligible(fns) {
    return fns.filter((f) => f.codeLines >= MIN_CODE_LINES && f.tests >= MIN_TESTS).map((f) => f.name);
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** A deterministic sample of `k` names for `seed`, returned sorted. */
export function selectFunctions(pool, k, seed) {
    if (k > pool.length)
        throw new Error(`k=${k} exceeds the pool of ${pool.length} functions`);
    const names = [...pool].sort();
    const random = mulberry32(seed);
    for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [names[i], names[j]] = [names[j], names[i]];
    }
    return names.slice(0, k).sort();
}
/** Remove the barrel lines that re-export `fns` (and their fp `...WithOptions` variants). */
export function stripBarrel(text, fns) {
    const drop = new Set();
    for (const fn of fns) {
        drop.add(`./${fn}/index.js`);
        drop.add(`./${fn}WithOptions/index.js`);
    }
    return text
        .split("\n")
        .filter((line) => {
        const m = /from\s+["'](\.\/[^"']+)["']/.exec(line);
        return !(m && drop.has(m[1]));
    })
        .join("\n");
}
/** The doc comment and signature of `export function <fn>` in `source`, or null if not found. */
export function docAndSignature(source, fn) {
    const at = source.search(new RegExp(`^export function ${fn}\\b`, "m"));
    if (at < 0)
        return null;
    const docStart = source.lastIndexOf("/**", at);
    const doc = docStart >= 0 ? source.slice(docStart, at).trimEnd() : "";
    const bodyStart = source.indexOf("{\n", at);
    const signature = (bodyStart >= 0 ? source.slice(at, bodyStart) : source.slice(at)).trimEnd();
    return { doc, signature };
}
export function taskBody(source, fn) {
    const found = docAndSignature(source, fn);
    if (!found)
        throw new Error(`export function ${fn} not found`);
    return [
        `Implement \`${fn}\` as a new module at \`src/${fn}/index.ts\`, following the documentation and signature below exactly (name, parameter order, options, return type, and the behaviour the description and examples specify). Use the repository's existing helpers (for example \`toDate\`, \`constructFrom\`, \`src/_lib\`) the way neighbouring functions do.`,
        "",
        `Export it from \`src/index.ts\`: that file is a generated barrel, so add the line \`export * from "./${fn}/index.js";\` by hand in alphabetical order instead of running the generator. Do not add an fp wrapper.`,
        "",
        `Add tests in \`src/${fn}/test.ts\` in the repository's existing style (vitest; \`describe("${fn}", ...)\`; import the function from \`./index.js\`).`,
        "",
        "Documentation and signature:",
        "",
        "```ts",
        found.doc,
        `${found.signature} {`,
        "  // ...",
        "}",
        "```",
    ].join("\n");
}
export function buildTasks(sourceRepo, fns) {
    return fns.map((fn) => ({
        id: fn,
        kind: "reimplement-function",
        title: `Implement \`${fn}\``,
        body: taskBody(readFileSync(join(sourceRepo, "src", fn, "index.ts"), "utf8"), fn),
        writes: [{ path: `src/${fn}/index.ts` }, { path: `src/${fn}/test.ts` }, { path: "src/index.ts", symbols: [fn] }],
        reads: [{ path: "src/toDate/index.ts" }, { path: "src/constructFrom/index.ts" }, { path: "src/constants/index.ts" }],
    }));
}
async function exists(p) {
    return existsSync(p);
}
/**
 * Ensure the date-fns source clone (with dependencies), pick K functions, and build the base clone with them removed
 * (one commit on top of v4.1.0). Idempotent per (k, seed) or explicit function list.
 */
export async function prepareScale(o) {
    const log = o.log ?? ((line) => console.error(`[scale] ${line}`));
    const tmp = o.tmp ?? benchRoot("scale");
    await mkdir(tmp, { recursive: true });
    const source = join(tmp, "date-fns-v4");
    if (!(await exists(join(source, ".git")))) {
        log(`cloning date-fns ${SCALE_TAG}`);
        await run("git", ["clone", "-q", "--depth", "1", "--branch", SCALE_TAG, SCALE_REPO_URL, source], { maxBuffer: 64 * 1024 * 1024 });
    }
    const head = await git(source, ["rev-parse", "HEAD"]);
    if (head !== SCALE_COMMIT)
        throw new Error(`${source} is at ${head}, expected ${SCALE_COMMIT}`);
    const nodeModules = join(source, "node_modules");
    if (!(await exists(join(nodeModules, "vitest")))) {
        log("installing dependencies (npm ci)");
        await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: source, maxBuffer: 64 * 1024 * 1024 });
    }
    const pool = eligible(leafFunctions(source));
    let functions;
    if (o.functions) {
        const missing = o.functions.filter((f) => !pool.includes(f));
        if (missing.length)
            throw new Error(`not eligible leaf functions: ${missing.join(", ")}`);
        functions = [...o.functions].sort();
    }
    else {
        functions = selectFunctions(pool, o.k, o.seed);
    }
    const label = o.functions ? `custom-${functions.length}-${hashNames(functions)}` : `k${functions.length}-s${o.seed}`;
    const base = join(tmp, `base-${label}`);
    const hiddenDir = join(tmp, `hidden-${label}`);
    if (!(await exists(join(base, ".scale-ready")))) {
        await rm(base, { recursive: true, force: true });
        log(`building base ${label}: removing ${functions.length} functions`);
        await run("git", ["clone", "-q", source, base], { maxBuffer: 64 * 1024 * 1024 });
        await git(base, ["checkout", "-q", "--detach", SCALE_COMMIT]);
        for (const fn of functions) {
            for (const dir of [join(base, "src", fn), join(base, "src", "fp", fn), join(base, "src", "fp", `${fn}WithOptions`)]) {
                await rm(dir, { recursive: true, force: true });
            }
        }
        for (const barrel of [join(base, "src", "index.ts"), join(base, "src", "fp", "index.ts")]) {
            await writeFile(barrel, stripBarrel(await readFile(barrel, "utf8"), functions));
        }
        // The base is an orphan commit: the removed implementations must not be recoverable from history.
        await git(base, ["checkout", "-q", "--orphan", "scale-base"]);
        await git(base, ["add", "-A"]);
        await git(base, ["-c", "user.name=Commons Bench", "-c", "user.email=bench@commons.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `scale: date-fns ${SCALE_TAG} without ${functions.length} functions\n\n${functions.join(" ")}`]);
        await git(base, ["tag", "-d", SCALE_TAG]).catch(() => undefined);
        await git(base, ["remote", "remove", "origin"]).catch(() => undefined);
        await git(base, ["reflog", "expire", "--expire=now", "--all"]);
        await git(base, ["gc", "-q", "--prune=now"]);
        await linkNodeModules(nodeModules, base);
        if (o.verifyBase !== false) {
            log("verifying the base suite is green");
            await run("npx", ["vitest", "run"], { cwd: base, maxBuffer: 64 * 1024 * 1024 });
        }
        await mkdir(hiddenDir, { recursive: true });
        for (const fn of functions)
            await writeFile(join(hiddenDir, `${fn}.test.ts`), await readFile(join(source, "src", fn, "test.ts"), "utf8"));
        await writeFile(join(base, ".scale-ready"), `${functions.join("\n")}\n`);
    }
    const baseCommit = await git(base, ["rev-parse", "HEAD"]);
    const set = { k: functions.length, seed: o.seed, sourceCommit: SCALE_COMMIT, baseCommit, functions, tasks: buildTasks(source, functions), hiddenDir };
    return {
        set,
        repoDir: base,
        nodeModules,
        testCommand: "npx vitest run",
        relatedCommand: "npx vitest related --run {files}",
    };
}
function hashNames(names) {
    let h = 2166136261;
    for (const ch of names.join(",")) {
        h ^= ch.charCodeAt(0);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}
//# sourceMappingURL=prepare.js.map