// Prepare the React Hook Form workload: a working clone at the task base with installed dependencies,
// and the task list for the runner.
import { access, readFile, symlink, mkdir } from "node:fs/promises";
import { benchRoot } from "../issues/prepare.js";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
const ROOT = resolve(new URL("../../..", import.meta.url).pathname); // platform/ (from src/bench/rhf or dist/bench/rhf)
const LEGACY_BASE_GIT = resolve(ROOT, "../output/mechanism-iteration/cooperbench-runtime-1/base.git");
async function exists(p) {
    try {
        await access(p);
        return true;
    }
    catch {
        return false;
    }
}
export async function loadTaskSet(name) {
    const set = JSON.parse(await readFile(join(ROOT, "bench/rhf", `tasks-${name}.json`), "utf8"));
    set.datasetDir = resolve(ROOT, "..", set.datasetDir);
    return set;
}
/**
 * Ensure a clone of react-hook-form at the task base exists under platform/tmp/rhf-<task> with dependencies installed.
 * task153 reuses the legacy base.git fixture; task85 clones from GitHub (network).
 */
export async function prepareRhf(name, opts = {}) {
    const set = await loadTaskSet(name);
    const tmp = opts.tmp ?? benchRoot();
    await mkdir(tmp, { recursive: true });
    const repoDir = join(tmp, `rhf-${name}`);
    if (!(await exists(join(repoDir, ".git")))) {
        if (name === "task153" && (await exists(LEGACY_BASE_GIT))) {
            await run("git", ["clone", "-q", LEGACY_BASE_GIT, repoDir]);
        }
        else {
            await run("git", ["clone", "-q", "https://github.com/react-hook-form/react-hook-form.git", repoDir], { maxBuffer: 64 * 1024 * 1024 });
        }
        await run("git", ["-C", repoDir, "checkout", "-q", "--detach", set.baseCommit]);
    }
    const head = (await run("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();
    if (head !== set.baseCommit)
        throw new Error(`${repoDir} is at ${head}, expected ${set.baseCommit}`);
    const nodeModules = join(repoDir, "node_modules");
    if (!(await exists(join(nodeModules, ".pnpm")))) {
        // pnpm major must match the lockfile: lockfileVersion '9.0' needs pnpm 9, '6.0' needs pnpm 8.
        const lock = await readFile(join(repoDir, "pnpm-lock.yaml"), "utf8").catch(() => "");
        const pnpm = /lockfileVersion:\s*'?9/.test(lock) ? "pnpm@9" : "pnpm@8";
        await run("npx", [pnpm, "install", "--frozen-lockfile"], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 });
    }
    return {
        set,
        repoDir,
        nodeModules,
        relatedCommand: "npx jest --config ./scripts/jest/jest.config.js --findRelatedTests {files} --watch=false",
        testCommand: "npx jest --config ./scripts/jest/jest.config.js --watch=false",
    };
}
/** Link installed dependencies into a fresh worktree so agents and checks can run jest without installing. */
export async function linkNodeModules(nodeModules, worktree) {
    const target = join(worktree, "node_modules");
    if (!(await exists(target)))
        await symlink(nodeModules, target, "dir");
}
//# sourceMappingURL=prepare.js.map