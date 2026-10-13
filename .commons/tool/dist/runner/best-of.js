// Best-of-N: several agents attempt the same task in separate worktrees, and verification picks the one to submit.
//
// Every candidate's own related check runs on its own tree; then each candidate's new or changed test files run
// against every other candidate's tree (in a copy-on-write clone). The winner passes its own check and the most of the
// others' tests: tests written independently from the same issue that a solution passes are evidence it does what the
// issue asks, beyond what its author thought to test (cross-candidate agreement). Ties go to the smaller change.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { excerptOf, parseFailedTests, renderCommand, runCommand } from "../executor/checks.js";
import { cowCopy } from "../executor/cow.js";
import { git, gitRaw } from "../executor/git.js";
import { checkSlotsFromEnv, PRIORITY_PREVERIFY, withCheckSlot } from "../executor/slots.js";
const TEST_PATH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;
async function changedOf(worktree, base, commit) {
    const files = (await git(worktree, ["diff", "--name-only", base, commit])).split("\n").filter(Boolean);
    const stat = await gitRaw(worktree, ["diff", "--numstat", base, commit]);
    const lines = stat.stdout
        .split("\n")
        .filter(Boolean)
        .reduce((n, l) => n + l.split("\t").slice(0, 2).reduce((m, x) => m + (Number(x) || 0), 0), 0);
    return { files, lines };
}
async function check(cwd, o, files) {
    const command = renderCommand(o.testCommand, o.relatedTemplate, files);
    const started = Date.now();
    const exec = () => runCommand(["sh", "-c", command], { cwd, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
    const slots = checkSlotsFromEnv();
    const r = slots ? await withCheckSlot(slots, exec, { priority: PRIORITY_PREVERIFY }) : await exec();
    return { passed: !r.timedOut && r.code === 0, failed: parseFailedTests(r.stdout, r.stderr), excerpt: excerptOf(r.output), durationMs: Date.now() - started };
}
/** Score the candidates and pick the winner (null when none has a commit). */
export async function selectCandidate(candidates, o) {
    const log = o.log ?? (() => undefined);
    const live = candidates.filter((c) => c.commit !== null);
    const scores = new Map();
    const changes = new Map();
    await Promise.all(live.map(async (c) => {
        const changed = await changedOf(c.worktree, o.base, c.commit);
        changes.set(c.index, changed);
        const own = changed.files.length > 0 ? await check(c.worktree, o, changed.files) : { passed: false, failed: [], excerpt: "no changes", durationMs: 0 };
        if (changed.files.length > 0 && o.onOwnCheck)
            await o.onOwnCheck(c, changed.files, own).catch(() => undefined);
        scores.set(c.index, {
            index: c.index,
            commit: c.commit,
            ownPassed: own.passed,
            ownFailed: own.failed,
            testFiles: changed.files.filter((f) => TEST_PATH.test(f)),
            crossPassed: 0,
            crossRun: 0,
            changedLines: changed.lines,
            score: 0,
            notes: [own.passed ? "own related check passed" : `own related check failed${own.failed.length ? ` (${own.failed.slice(0, 3).join(", ")})` : ""}`],
        });
    }));
    // Cross-candidate tests: i's test files on j's tree.
    if (live.length > 1) {
        const scratch = o.scratch ?? tmpdir();
        mkdirSync(scratch, { recursive: true });
        for (const j of live) {
            const sj = scores.get(j.index);
            for (const i of live) {
                if (i.index === j.index)
                    continue;
                const tests = scores.get(i.index).testFiles;
                if (tests.length === 0)
                    continue;
                const clone = join(mkdtempSync(join(scratch, "commons-cross-")), "tree");
                try {
                    await cowCopy(j.worktree, clone);
                    for (const file of tests) {
                        const content = await gitRaw(i.worktree, ["show", `${i.commit}:${file}`]);
                        if (content.code !== 0)
                            continue;
                        mkdirSync(dirname(join(clone, file)), { recursive: true });
                        writeFileSync(join(clone, file), content.stdout);
                    }
                    const r = await check(clone, o, tests);
                    sj.crossRun++;
                    if (r.passed)
                        sj.crossPassed++;
                    sj.notes.push(`candidate ${i.index}'s ${tests.length} test file(s) ${r.passed ? "pass" : "fail"} here`);
                }
                catch (error) {
                    sj.notes.push(`candidate ${i.index}'s tests could not run here: ${error instanceof Error ? error.message : String(error)}`);
                }
                finally {
                    rmSync(dirname(clone), { recursive: true, force: true });
                }
            }
        }
    }
    for (const s of scores.values())
        s.score = (s.ownPassed ? 1000 : 0) + s.crossPassed * 10 - Math.min(9, s.changedLines / 200);
    const ranked = [...scores.values()].sort((a, b) => b.score - a.score || a.changedLines - b.changedLines || a.index - b.index);
    for (const s of ranked)
        log(`candidate ${s.index} (${s.commit?.slice(0, 8) ?? "no commit"}): score ${s.score.toFixed(1)}; ${s.notes.join("; ")}`);
    const winner = ranked[0] ? (candidates.find((c) => c.index === ranked[0].index) ?? null) : null;
    return { winner, scores: ranked };
}
//# sourceMappingURL=best-of.js.map