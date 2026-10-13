// Official scoring for the scale workload: on a checkout of the final main, overwrite each task's test file with
// the original date-fns test plus a barrel-export check, run vitest once, and report per task.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { git } from "../../executor/git.js";
import { linkNodeModules } from "../rhf/prepare.js";
const run = promisify(execFile);
/** The original test file plus a check that the function is exported from the package barrel. */
export function hiddenTestWithBarrelCheck(fn, original) {
    return `${original.trimEnd()}

// Added by the Commons scale benchmark: the function must be exported from the package barrel.
import * as commonsBarrel from "../index.js";
import { describe as commonsDescribe, expect as commonsExpect, it as commonsIt } from "vitest";
commonsDescribe("${fn} (barrel)", () => {
  commonsIt("is exported from src/index.ts", () => {
    commonsExpect(typeof (commonsBarrel as Record<string, unknown>).${fn}).toBe("function");
  });
});
`;
}
/** Per-function results from a vitest JSON report keyed by `src/<fn>/test.ts`. */
export function parseVitestJson(json, functions) {
    const out = new Map();
    for (const fn of functions) {
        const file = json.testResults.find((t) => t.name.split("\\").join("/").endsWith(`/src/${fn}/test.ts`));
        if (!file) {
            out.set(fn, { passed: false, testsPassed: 0, testsFailed: 0, failedNames: [], error: "test file did not run" });
            continue;
        }
        const failed = file.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName);
        const passed = file.status === "passed" && failed.length === 0 && file.assertionResults.length > 0;
        const entry = {
            passed,
            testsPassed: file.assertionResults.filter((a) => a.status === "passed").length,
            testsFailed: failed.length,
            failedNames: failed,
        };
        if (!passed && failed.length === 0)
            entry.error = (file.message ?? "suite failed").split("\n").slice(0, 3).join(" ");
        out.set(fn, entry);
    }
    return out;
}
export async function scoreScale(o) {
    const began = Date.now();
    await mkdir(o.out, { recursive: true });
    const checkout = join(o.out, "checkout");
    await rm(checkout, { recursive: true, force: true });
    await run("git", ["clone", "-q", "--no-checkout", o.repo, checkout], { maxBuffer: 64 * 1024 * 1024 });
    await git(checkout, ["checkout", "-q", "--detach", o.commit]);
    await linkNodeModules(o.nodeModules, checkout);
    for (const fn of o.functions) {
        await mkdir(join(checkout, "src", fn), { recursive: true });
        const original = await readFile(join(o.hiddenDir, `${fn}.test.ts`), "utf8");
        await writeFile(join(checkout, "src", fn, "test.ts"), o.barrelCheck === false ? original : hiddenTestWithBarrelCheck(fn, original));
    }
    const reportPath = join(o.out, "vitest.json");
    let exitCode = 0;
    let stderr = "";
    try {
        const r = await run("npx", ["vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, ...o.functions.map((fn) => `src/${fn}/test.ts`)], {
            cwd: checkout,
            maxBuffer: 64 * 1024 * 1024,
            timeout: o.timeoutMs ?? 10 * 60 * 1000,
        });
        stderr = r.stderr;
    }
    catch (error) {
        const e = error;
        exitCode = typeof e.code === "number" ? e.code : null;
        stderr = e.stderr ?? String(error);
    }
    await writeFile(join(o.out, "stderr.log"), stderr);
    let parsed;
    try {
        parsed = parseVitestJson(JSON.parse(await readFile(reportPath, "utf8")), o.functions);
    }
    catch (error) {
        parsed = new Map(o.functions.map((fn) => [fn, { passed: false, testsPassed: 0, testsFailed: 0, failedNames: [], error: `no vitest report: ${error.message}` }]));
    }
    const durationMs = Date.now() - began;
    const results = o.functions.map((fn) => {
        const p = parsed.get(fn);
        const r = { feature: fn, passed: p.passed, testsPassed: p.testsPassed, testsFailed: p.testsFailed, total: p.testsPassed + p.testsFailed, failedNames: p.failedNames, exitCode, durationMs };
        if (p.error)
            r.error = p.error;
        return r;
    });
    await writeFile(join(o.out, "official.json"), JSON.stringify(results, null, 2));
    return results;
}
//# sourceMappingURL=official.js.map