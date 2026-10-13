// The context-migration workload: date-fns v4.1.0 with K functions reverted to their v3.6.0 code (before the `in`
// context option). Each task migrates one function; its hidden test is the v4.1.0 test file. Functions that call
// each other with the option depend on each other, so the selection is closed under "callers of a selected function"
// and every such edge becomes `dependsOn` plus a read scope on the callee.
import { execFile } from "node:child_process";
import { benchRoot } from "../issues/prepare.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { git } from "../../executor/git.js";
import { linkNodeModules } from "../rhf/prepare.js";
import { docAndSignature } from "../scale/prepare.js";
import { analyzeContextMigration, isEligible, NEW_TAG, OLD_TAG, SHARED } from "./analyze.js";
const run = promisify(execFile);
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
/** function -> functions (among `all`) whose new implementation imports it. */
export function importersOf(all) {
    const map = new Map();
    for (const c of all)
        for (const dep of c.importsInNew)
            map.set(dep, [...(map.get(dep) ?? []), c.name]);
    for (const [k, v] of map)
        map.set(k, v.sort());
    return map;
}
/** The transitive callers of `name` among `all` (excluding itself). */
export function closureOf(name, importers) {
    const seen = new Set();
    const stack = [name];
    while (stack.length) {
        const n = stack.pop();
        for (const caller of importers.get(n) ?? []) {
            if (seen.has(caller))
                continue;
            seen.add(caller);
            stack.push(caller);
        }
    }
    seen.delete(name);
    return [...seen].sort();
}
/**
 * Pick up to `k` functions deterministically: walk the shuffled eligible list and take a seed with all its transitive
 * callers when every caller is eligible and the result still fits in `k`. A reverted function whose caller stays at
 * v4.1 would break that caller's context tests in the base, so callers always come along.
 */
export function selectWithClosure(all, eligible, k, seed, opts = {}) {
    const importers = importersOf(all);
    const names = [...eligible].sort();
    const random = mulberry32(seed);
    for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [names[i], names[j]] = [names[j], names[i]];
    }
    if (opts.preferDependent !== false) {
        // Seeds that call another eligible function first (stable), so the selection carries producer -> consumer edges.
        const byNameAll = new Map(all.map((c) => [c.name, c]));
        const dependent = names.filter((n) => (byNameAll.get(n)?.importsInNew ?? []).some((d) => eligible.has(d)));
        const rest = names.filter((n) => !dependent.includes(n));
        names.splice(0, names.length, ...dependent, ...rest);
    }
    const selected = new Set();
    for (const name of names) {
        if (selected.size >= k)
            break;
        if (selected.has(name))
            continue;
        const group = [name, ...closureOf(name, importers)].filter((n) => !selected.has(n));
        if (group.some((n) => !eligible.has(n)))
            continue;
        if (selected.size + group.length > k)
            continue;
        for (const n of group)
            selected.add(n);
    }
    const functions = [...selected].sort();
    const byName = new Map(all.map((c) => [c.name, c]));
    const dependencies = {};
    for (const fn of functions)
        dependencies[fn] = (byName.get(fn)?.importsInNew ?? []).filter((d) => selected.has(d)).sort();
    return { functions, dependencies };
}
export const MIGRATION_GUIDE = `Migration guide (date-fns v4 context option):
- Every function that takes dates accepts \`options.in\` (type \`ContextOptions<DateType>\` from \`src/types.ts\`, a \`ContextFn\`). The context normalizes every date argument into one date instance type (for example a \`TZDate\` carrying a time zone) and the result is constructed in that type.
- Convert arguments with \`toDate(date, options?.in)\` and construct results with \`constructFrom(options?.in || date, value)\`. When a function takes two or more dates, normalize them together with \`normalizeDates(options?.in, a, b)\` from \`src/_lib/normalizeDates/index.js\`.
- Argument types become \`DateArg<DateType>\` and the result type is the \`ResultDate\` type parameter (default \`DateType\`), as in the signature below; the function's options interface extends \`ContextOptions<DateType>\`.
- When the function delegates to other date-fns functions, pass \`options\` through (or \`{ in: options?.in }\` when the callee's option type differs) so the context reaches every step.
- Behaviour for callers that pass no context must not change.`;
export function taskBody(newSource, fn, dependencies) {
    const found = docAndSignature(newSource, fn);
    if (!found)
        throw new Error(`export function ${fn} not found`);
    const deps = dependencies.length > 0
        ? `\nThis function calls ${dependencies.map((d) => `\`${d}\``).join(", ")}, which ${dependencies.length === 1 ? "is" : "are"} being migrated concurrently by the task${dependencies.length === 1 ? "" : "s"} with the same name${dependencies.length === 1 ? "" : "s"}; pass \`options\` through to ${dependencies.length === 1 ? "it" : "them"} and build on ${dependencies.length === 1 ? "its" : "their"} landed or submitted change rather than re-implementing ${dependencies.length === 1 ? "it" : "them"}.\n`
        : "";
    return [
        `Add the \`in\` context option to \`${fn}\` (\`src/${fn}/index.ts\`), following the documentation and signature below exactly. Extend the tests in \`src/${fn}/test.ts\` with context cases in the repository's existing style (see any already-migrated function's test file, e.g. \`src/toDate/test.ts\`).`,
        deps,
        MIGRATION_GUIDE,
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
export function buildTasks(repo, functions, dependencies, newSources) {
    return functions.map((fn) => {
        const deps = dependencies[fn] ?? [];
        return {
            id: fn,
            kind: "context-option",
            title: `Add the context option to \`${fn}\``,
            body: taskBody(newSources.get(fn), fn, deps),
            writes: [{ path: `src/${fn}/index.ts` }, { path: `src/${fn}/test.ts` }],
            reads: [{ path: "src/types.ts" }, { path: "src/toDate/index.ts" }, { path: "src/constructFrom/index.ts" }, ...deps.map((d) => ({ path: `src/${d}/index.ts` }))],
            dependsOn: deps,
        };
    });
}
async function show(repo, rev, path) {
    const { stdout } = await run("git", ["-C", repo, "show", `${rev}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}
export async function prepareContext(o) {
    const log = o.log ?? ((line) => console.error(`[context] ${line}`));
    const tmp = o.tmp ?? benchRoot("scale");
    const source = join(tmp, "date-fns-v4");
    if (!existsSync(join(source, ".git")))
        throw new Error(`${source} missing: run the scale workload preparation first (it clones date-fns ${NEW_TAG})`);
    const nodeModules = join(source, "node_modules");
    if (!existsSync(join(nodeModules, "vitest")))
        throw new Error(`${nodeModules} missing: npm ci in ${source}`);
    try {
        await git(source, ["rev-parse", "--verify", `${OLD_TAG}^{commit}`]);
    }
    catch {
        log(`fetching ${OLD_TAG}`);
        await run("git", ["-C", source, "fetch", "-q", "--depth", "1", "origin", "tag", OLD_TAG]);
    }
    const analysisPath = join(tmp, "context-analysis.json");
    let analysis;
    if (existsSync(analysisPath))
        analysis = JSON.parse(await readFile(analysisPath, "utf8"));
    else {
        log("no analysis found; validating every changed function (about 20 minutes)");
        analysis = await analyzeContextMigration({ repo: source, out: tmp, log });
    }
    const eligible = new Set(analysis.filter((c) => isEligible(c) && !SHARED.has(c.name)).map((c) => c.name));
    if (eligible.size === 0)
        throw new Error("no eligible functions in the analysis (run the validation)");
    let functions;
    let dependencies;
    if (o.functions) {
        const missing = o.functions.filter((f) => !eligible.has(f));
        if (missing.length)
            throw new Error(`not eligible: ${missing.join(", ")}`);
        const importers = importersOf(analysis);
        const sel = new Set(o.functions);
        for (const f of o.functions)
            for (const caller of closureOf(f, importers))
                if (!sel.has(caller))
                    throw new Error(`${caller} calls ${f} with the option and must be included`);
        functions = [...sel].sort();
        const byName = new Map(analysis.map((c) => [c.name, c]));
        dependencies = Object.fromEntries(functions.map((fn) => [fn, (byName.get(fn)?.importsInNew ?? []).filter((d) => sel.has(d)).sort()]));
    }
    else {
        ({ functions, dependencies } = selectWithClosure(analysis, eligible, o.k, o.seed));
    }
    if (functions.length === 0)
        throw new Error("selection is empty");
    const label = o.functions ? `custom-${functions.length}` : `k${functions.length}-s${o.seed}`;
    const base = join(tmp, `context-base-${label}`);
    const hiddenDir = join(tmp, `context-hidden-${label}`);
    if (!existsSync(join(base, ".context-ready"))) {
        await rm(base, { recursive: true, force: true });
        log(`building base ${label}: reverting ${functions.length} functions to ${OLD_TAG}`);
        await run("git", ["clone", "-q", source, base], { maxBuffer: 64 * 1024 * 1024 });
        await git(base, ["checkout", "-q", "--detach", NEW_TAG]);
        await mkdir(hiddenDir, { recursive: true });
        for (const fn of functions) {
            await writeFile(join(hiddenDir, `${fn}.test.ts`), await readFile(join(base, "src", fn, "test.ts"), "utf8"));
            await writeFile(join(base, "src", fn, "index.ts"), await show(source, OLD_TAG, `src/${fn}/index.ts`));
            await writeFile(join(base, "src", fn, "test.ts"), await show(source, OLD_TAG, `src/${fn}/test.ts`));
        }
        // Orphan history: the migrated implementations must not be recoverable from git.
        await git(base, ["checkout", "-q", "--orphan", "context-base"]);
        await git(base, ["add", "-A"]);
        await git(base, ["-c", "user.name=Commons Bench", "-c", "user.email=bench@commons.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `context: date-fns ${NEW_TAG} with ${functions.length} functions at ${OLD_TAG}\n\n${functions.join(" ")}`]);
        for (const tag of [OLD_TAG, NEW_TAG, "v4.0.0"])
            await git(base, ["tag", "-d", tag]).catch(() => undefined);
        await git(base, ["remote", "remove", "origin"]).catch(() => undefined);
        await git(base, ["reflog", "expire", "--expire=now", "--all"]);
        await git(base, ["gc", "-q", "--prune=now"]);
        await linkNodeModules(nodeModules, base);
        if (o.verifyBase !== false) {
            log("verifying the base suite is green");
            await run("npx", ["vitest", "run"], { cwd: base, maxBuffer: 64 * 1024 * 1024 });
        }
        await writeFile(join(base, ".context-ready"), `${functions.join("\n")}\n`);
    }
    const baseCommit = await git(base, ["rev-parse", "HEAD"]);
    const newSources = new Map();
    for (const fn of functions)
        newSources.set(fn, await readFile(join(source, "src", fn, "index.ts"), "utf8"));
    const set = { k: functions.length, seed: o.seed, oldTag: OLD_TAG, newTag: NEW_TAG, baseCommit, functions, dependencies, tasks: buildTasks(source, functions, dependencies, newSources), hiddenDir };
    return { set, repoDir: base, nodeModules, testCommand: "npx vitest run", relatedCommand: "npx vitest related --run {files}" };
}
//# sourceMappingURL=prepare.js.map