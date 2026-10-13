// Official scoring for the issues workload: on a checkout of the final main, write each task's hidden test files
// (the PR's test files at its merge commit), run them per package, and pass a task when all of its files pass.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "../../executor/git.js";
import { buildPackages, detectToolchain, exec, groupByPackage, readPackage, vitestInPackage } from "../../verify/workspace.js";
import { packageProfile, readProfile } from "../../verify/profile.js";
import { selfBuildOf } from "./check.js";
/** Map a vitest JSON report to outcomes keyed by package-relative test path. */
export function outcomesByFile(json, files) {
    const out = new Map();
    for (const f of files) {
        const r = json.testResults.find((t) => t.name.split("\\").join("/").endsWith(`/${f}`));
        if (!r) {
            out.set(f, { passed: false, failedNames: [], error: "did not run" });
            continue;
        }
        const failed = r.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName);
        const passed = r.status === "passed" && failed.length === 0 && r.assertionResults.length > 0;
        out.set(f, { passed, failedNames: failed, ...(passed || failed.length ? {} : { error: (r.message ?? "suite failed").split("\n").slice(0, 3).join(" ") }) });
    }
    return out;
}
export async function scoreIssues(o) {
    const began = Date.now();
    await mkdir(o.out, { recursive: true });
    const checkout = join(o.out, "checkout");
    await rm(checkout, { recursive: true, force: true });
    const c = await exec("git", ["clone", "-q", "--no-checkout", o.repo, checkout], { cwd: o.out });
    if (c.code !== 0)
        throw new Error(`clone failed: ${c.stderr}`);
    await git(checkout, ["checkout", "-q", "--detach", o.commit]);
    await o.prepareCheckout(checkout);
    const allFiles = o.set.tasks.flatMap((t) => t.testFiles.map((f) => f.path));
    // As the project profile says the tests run: per package, or all from the root's one runner config.
    const groups = readProfile(checkout).layout === "root" ? new Map([[".", allFiles]]) : groupByPackage(allFiles);
    const turbo = detectToolchain(checkout).turbo;
    const outcomes = new Map();
    // Every build before any hidden test is written: a package whose build type-checks its test files (miniflare's
    // `build` runs `types:build`) would otherwise fail on another task's hidden tests, and with it every package that
    // depends on it. From run 13 to run 25 that scored 13 of the 25 workers-sdk tasks as failed in both arms.
    const built = new Map();
    for (const dir of groups.keys()) {
        const pkg = readPackage(checkout, dir);
        const own = packageProfile(checkout, dir).build;
        built.set(dir, turbo
            ? await buildPackages(checkout, [pkg.name], selfBuildOf(checkout), o.env, [pkg])
            : own
                ? await exec(own[0], own.slice(1), { cwd: join(checkout, dir), env: o.env })
                : { code: 0, stdout: "", stderr: "" });
    }
    for (const t of o.set.tasks) {
        for (const f of t.testFiles) {
            const p = join(checkout, f.path);
            await mkdir(dirname(p), { recursive: true });
            await writeFile(p, await readFile(join(o.hiddenDir, t.id, f.path), "utf8"));
        }
    }
    for (const [dir, rel] of groups) {
        const pkg = readPackage(checkout, dir);
        const b = built.get(dir);
        if (b.code !== 0) {
            for (const f of rel)
                outcomes.set(dir === "." ? f : `${dir}/${f}`, { passed: false, failedNames: [], error: `build failed: ${b.stderr.slice(-500)}` });
            continue;
        }
        const report = join(o.out, `${pkg.name.replace(/[@/]/g, "_")}.vitest.json`);
        const r = await vitestInPackage(checkout, pkg, "run", rel, ["--reporter=json", `--outputFile=${report}`], o.env);
        await writeFile(join(o.out, `${pkg.name.replace(/[@/]/g, "_")}.stderr.log`), r.stderr);
        try {
            const parsed = outcomesByFile(JSON.parse(await readFile(report, "utf8")), rel);
            for (const [f, v] of parsed)
                outcomes.set(dir === "." ? f : `${dir}/${f}`, v);
        }
        catch (error) {
            for (const f of rel)
                outcomes.set(dir === "." ? f : `${dir}/${f}`, { passed: false, failedNames: [], error: `no report: ${error.message}` });
        }
    }
    const durationMs = Date.now() - began;
    const results = o.set.tasks.map((t) => {
        const files = t.testFiles.map((f) => outcomes.get(f.path) ?? { passed: false, failedNames: [], error: "missing" });
        const failedNames = files.flatMap((f) => f.failedNames);
        const errors = files.map((f) => f.error).filter((e) => !!e);
        const r = { feature: t.id, passed: files.length > 0 && files.every((f) => f.passed), failedNames, exitCode: 0, durationMs, testsFailed: failedNames.length };
        if (errors.length)
            r.error = errors.join("; ");
        return r;
    });
    await writeFile(join(o.out, "official.json"), JSON.stringify(results, null, 2));
    return results;
}
//# sourceMappingURL=official.js.map