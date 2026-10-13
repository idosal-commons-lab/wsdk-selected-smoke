// Official CooperBench scoring for the React Hook Form workload.
// For each feature: take the candidate's src/ diff from the task base (excluding test files), apply it inside the
// pinned image, apply the official tests.patch for that feature, and run the official test file.
// Containers run with --network none, 2 CPUs, 2 GiB, like the published harness.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
const run = promisify(execFile);
async function git(repo, args) {
    const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}
async function docker(args, timeoutMs) {
    try {
        const { stdout, stderr } = await run("docker", args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
        return { code: 0, stdout, stderr };
    }
    catch (error) {
        const e = error;
        return { code: typeof e.code === "number" ? e.code : null, stdout: e.stdout ?? "", stderr: e.stderr ?? String(error) };
    }
}
function testFilesFromPatch(patch) {
    return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
}
export async function sourcePatch(repo, base, commit, includeAuthoredTests) {
    const names = (await git(repo, ["diff", "--name-only", base, commit, "--", "src/"]))
        .split("\n")
        .filter(Boolean)
        .filter((p) => includeAuthoredTests || !p.split("/").some((c) => c === "__tests__" || c === "__typetest__"));
    if (names.length === 0)
        return "";
    return git(repo, ["diff", "--binary", base, commit, "--", ...names]);
}
export async function officialScore(o) {
    const timeoutMs = o.timeoutMs ?? 10 * 60 * 1000;
    await mkdir(o.out, { recursive: true });
    const patch = await sourcePatch(o.repo, o.base, o.commit, o.includeAuthoredTests ?? false);
    const patchPath = join(o.out, "source.patch");
    await writeFile(patchPath, patch);
    const results = [];
    for (const feature of o.features) {
        const began = Date.now();
        const dir = join(o.out, feature);
        await mkdir(dir, { recursive: true });
        const name = `commons-official-${randomUUID()}`;
        const testsPatchPath = join(o.datasetDir, feature, "tests.patch");
        const testsPatch = await readFile(testsPatchPath, "utf8");
        const testFiles = o.testFiles ?? testFilesFromPatch(testsPatch);
        const result = { feature, passed: false, failedNames: [], exitCode: null, durationMs: 0 };
        try {
            const created = await docker(["create", "--name", name, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--cpus", "2", "--memory", "2g", "--pids-limit", "256", "--entrypoint", "/bin/sh", o.image, "-c", "sleep infinity"], 60_000);
            if (created.code !== 0)
                throw new Error("container create failed: " + created.stderr);
            for (const args of [["start", name], ["exec", name, "mkdir", "-p", "/patches"], ["cp", patchPath, `${name}:/patches/source.patch`], ["cp", testsPatchPath, `${name}:/patches/tests.patch`]]) {
                const r = await docker(args, 60_000);
                if (r.code !== 0)
                    throw new Error(`${args[0]} failed: ${r.stderr}`);
            }
            if (patch) {
                const applied = await docker(["exec", "-w", "/workspace/repo", name, "git", "apply", "--ignore-whitespace", "--ignore-space-change", "/patches/source.patch"], 60_000);
                if (applied.code !== 0)
                    throw new Error("source apply failed: " + applied.stderr);
            }
            const testsApplied = await docker(["exec", "-w", "/workspace/repo", name, "git", "apply", "--ignore-whitespace", "--ignore-space-change", "/patches/tests.patch"], 60_000);
            if (testsApplied.code !== 0)
                throw new Error("official tests apply failed: " + testsApplied.stderr);
            const check = await docker(["exec", "-w", "/workspace/repo", name, "node", "node_modules/jest/bin/jest.js", "--config", "./scripts/jest/jest.config.js", ...testFiles, "--runInBand", "--watch=false", "--json", "--outputFile", "/tmp/check.json"], timeoutMs);
            await writeFile(join(dir, "stdout.log"), check.stdout);
            await writeFile(join(dir, "stderr.log"), check.stderr);
            const copied = await docker(["cp", `${name}:/tmp/check.json`, join(dir, "jest.json")], 60_000);
            const j = copied.code === 0 ? JSON.parse(await readFile(join(dir, "jest.json"), "utf8")) : undefined;
            result.exitCode = check.code;
            result.passed = check.code === 0 && j?.success === true;
            result.testsPassed = j?.numPassedTests;
            result.testsFailed = j?.numFailedTests;
            result.total = j?.numTotalTests;
            result.failedNames = j?.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === "failed").map((a) => a.fullName)) ?? [];
        }
        catch (error) {
            result.error = error.message;
        }
        finally {
            await docker(["rm", "-f", name], 30_000);
            result.durationMs = Date.now() - began;
            await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2));
            results.push(result);
        }
    }
    await writeFile(join(o.out, "official.json"), JSON.stringify(results, null, 2));
    return results;
}
//# sourceMappingURL=official.js.map