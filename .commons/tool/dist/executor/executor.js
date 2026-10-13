// The integration pipeline (SPEC §8): lease -> merge -> check -> bisect -> land -> report.
import { ClientError } from "../adapter/client.js";
import { diffContracts } from "../index/contracts.js";
import { structuredMerge } from "./structured-merge.js";
import { landingNoteFrom, pushNotes, writeLandingNote } from "./notes.js";
import { llmResolve, llmResolveAvailable, reapplyResolutions, } from "./llm-resolve.js";
import { changedFiles, commitTree, git, gitRaw, hasCommit, isAncestor, mergeBase, mergeTree, showFile, treeOf } from "./git.js";
import { closureIndex, footprintOf, landingsBetween, transferable } from "./footprint.js";
import { ensureWorkClone, HOST_MAIN_REF } from "./host.js";
import { checkoutDetached, CommandCheck, inconclusive, runChecks } from "./checks.js";
import { blobsOf, closureKey } from "./verdict-key.js";
import { directDependents, workspacePackages } from "../verify/dependents.js";
import { lanesOf, nextLane } from "./lanes.js";
import { readProfile, recordsDirOf } from "../verify/profile.js";
import { impactOf, sharedTests } from "../verify/interaction.js";
import { failingTestFiles } from "../verify/check.js";
const DEFAULT_BATCH_SIZE = 4;
/**
 * Submissions whose own pre-verification holds on main: independent, by coverage and by imports, of everything that
 * landed since their fork, with no exported signature changed (optimisticGate). By pre-verification closure key.
 */
const carriedVerdicts = new Map();
/** Submissions whose check before landing ran out of time, and how often (see integrateLease). */
const timedOutChecks = new Map();
/** How long a submission is deferred for a running pre-verification before it goes through a checked batch instead. */
const DEFAULT_PREVERIFY_GRACE_MS = 30 * 60 * 1000;
const DEFAULT_LLM_RESOLVE_CONCURRENCY = 3;
const DEFAULT_LLM_RESOLVE_BUDGET_MS = 180_000;
/** Model attempts per submission in one batch: one against the candidate it first saw, one more if that moved. */
const MAX_MODEL_ATTEMPTS = 2;
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs)$/;
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
function unique(values) {
    return [...new Set(values)];
}
function verdictOf(ev, extra = {}) {
    const failed = ev.results.filter((r) => !r.passed);
    const last = ev.results[ev.results.length - 1];
    return {
        passed: ev.passed,
        failedTests: unique(failed.flatMap((r) => r.failedTests)),
        conflicts: [],
        excerpt: failed[0]?.excerpt ?? last?.excerpt ?? "no checks configured",
        checkTreeSha: ev.tree,
        cached: ev.results.length > 0 && ev.results.every((r) => r.cached),
        durationMs: ev.results.reduce((sum, r) => sum + r.durationMs, 0),
        ...extra,
    };
}
async function ensureCommit(work, host, commit) {
    if (await hasCommit(work, commit))
        return;
    if (host.fetchMain)
        await host.fetchMain(work);
    else
        await git(work, ["fetch", "--quiet", host.url, `+refs/heads/main:${HOST_MAIN_REF}`]);
    // A stacked lease starts from another batch's published candidate.
    if (!(await hasCommit(work, commit)))
        await gitRaw(work, ["fetch", "--quiet", host.url, "+refs/candidates/*:refs/candidates/*"]);
    if (!(await hasCommit(work, commit))) {
        throw new Error(`lease.fromMain ${commit} is not reachable from ${host.url}`);
    }
}
async function summarize(work, a) {
    const out = [];
    for (const file of a.changed) {
        let symbolsChanged = [];
        let contractChanges = [];
        if (CODE_FILE.test(file.path)) {
            const before = file.status === "A" ? null : await showFile(work, a.prev, file.path);
            const after = file.status === "D" ? null : await showFile(work, a.candidate, file.path);
            const diff = diffContracts(file.path, before, after);
            symbolsChanged = diff.symbolsChanged;
            contractChanges = diff.contractChanges;
        }
        out.push({ path: file.path, status: file.status, symbolsChanged, contractChanges });
    }
    return out;
}
/**
 * What to merge for a submission onto `onto`: its commit and their merge base, except when the submission is built on
 * an earlier submission of its task that landed optimistically and was reverted. That commit is an ancestor of main
 * although its changes are not in it, so a plain merge would bring only what came after it; instead the submission's
 * tree is merged from where the reverted one started (a one-parent commit of its tree on that fork point).
 */
async function mergeInputs(o, onto, commit, submission) {
    const { work } = o;
    for (const r of submission?.reverted ?? []) {
        if (!(await isAncestor(work, r.commit, commit)))
            continue;
        await ensureCommit(work, o.host, r.prevMain);
        const fork = await mergeBase(work, r.prevMain, commit);
        const theirs = await commitTree(work, await treeOf(work, commit), [fork], `commons: ${submission.taskId} from before its reverted landing`);
        return { base: fork, theirs, fromRevert: true };
    }
    return { base: await mergeBase(work, onto, commit), theirs: commit, fromRevert: false };
}
/** git merge, then the structured merges; a conflict that survives both is returned for the model. */
async function mergeStructurally(o, candidate, commit, submission) {
    const { work } = o;
    let base;
    let theirs;
    try {
        const inputs = await mergeInputs(o, candidate, commit, submission);
        if (!inputs.fromRevert && (await isAncestor(work, commit, candidate)))
            return { kind: "noop" };
        base = inputs.base;
        theirs = inputs.theirs;
    }
    catch (error) {
        return { kind: "error", excerpt: `no common ancestor with main: ${message(error)}` };
    }
    const merged = await mergeTree(work, base, candidate, theirs);
    if (merged.conflicts.length === 0)
        return { kind: "clean", tree: merged.tree, note: "" };
    const structured = o.structuredMerge !== false
        ? await structuredMerge(work, base, candidate, theirs, merged.tree, merged.conflicts, { ...(o.replay === false ? { replay: false } : {}) })
        : null;
    if (structured)
        return { kind: "clean", tree: structured.tree, note: structuredNote(structured) };
    return { kind: "conflict", conflict: { base, ours: candidate, conflictedTree: merged.tree, conflicts: merged.conflicts } };
}
/** "(structural replay in a; syntax-aware merge in b)": which resolver produced each conflicted path. */
function structuredNote(result) {
    const replayed = result.resolved.filter((p) => result.by?.[p] === "replay");
    const syntax = result.resolved.filter((p) => result.by?.[p] !== "replay");
    const parts = [
        ...(replayed.length > 0 ? [`structural replay in ${replayed.join(", ")}`] : []),
        ...(syntax.length > 0 ? [`syntax-aware merge in ${syntax.join(", ")}`] : []),
    ];
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}
function modelNote(result) {
    return ` (model-resolved conflict in ${result.resolved.join(", ")})`;
}
/** Commit a clean merge of `submission` onto `prev` (a no-op stays at `prev`). */
async function mergeCommit(work, submission, prev, merge) {
    if (merge.kind === "noop")
        return { submission, prev, candidate: prev, changed: [] };
    const next = await commitTree(work, merge.tree, [prev, submission.commit], `Land ${submission.taskId}: ${submission.summary}${merge.note}`);
    const resolved = merge.note.includes("model-resolved")
        ? "model-resolved"
        : merge.note.includes("syntax-aware")
            ? "syntax-aware"
            : merge.note.includes("structural replay")
                ? "replay"
                : undefined;
    return { submission, prev, candidate: next, changed: await changedFiles(work, prev, next), ...(resolved ? { resolved } : {}) };
}
async function contractChangesBetween(work, from, to, paths) {
    const out = [];
    for (const path of paths) {
        const [before, after] = await Promise.all([showFile(work, from, path), showFile(work, to, path)]);
        for (const c of diffContracts(path, before, after).contractChanges)
            out.push({ path, ...c });
    }
    return out;
}
/**
 * The contract evidence the agents get in their deltas, built for the resolver from what the executor has: every
 * exported signature of a conflicted code file that changed between the submission's merge base and the candidate
 * it is merged onto, attributed to the batch's earlier landings that touched the file and otherwise to main as it
 * was before the batch; plus what the incoming submission is for.
 */
async function resolveEvidence(work, conflict, landedSoFar, submission) {
    const paths = conflict.conflicts.map((c) => c.path).filter((p) => CODE_FILE.test(p));
    const landed = [];
    const attributed = new Set();
    for (const a of landedSoFar) {
        const touched = paths.filter((p) => a.changed.some((c) => c.path === p));
        if (touched.length === 0)
            continue;
        const contractChanges = await contractChangesBetween(work, a.prev, a.candidate, touched);
        for (const c of contractChanges)
            attributed.add(`${c.path}\0${c.symbol}`);
        landed.push({ taskId: a.submission.taskId, summary: a.submission.summary, contractChanges });
    }
    const onMain = (await contractChangesBetween(work, conflict.base, conflict.ours, paths)).filter((c) => !attributed.has(`${c.path}\0${c.symbol}`));
    if (onMain.length > 0)
        landed.push({ taskId: "main", contractChanges: onMain });
    return { landed, incoming: { taskId: submission.taskId, summary: submission.summary } };
}
async function forEachConcurrent(items, limit, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length)
            await fn(items[next++]);
    });
    await Promise.all(workers);
}
/**
 * Take one lease, merge its submissions onto `fromMain` in order, run the checks on the
 * combined candidate, bisect by prefix on failure, land the longest passing prefix, push
 * main, and report. Returns null when nothing was leased.
 */
/** Speculation needs a host that reports its main and a client that publishes candidates and reads lease state. */
function canSpeculate(o) {
    return o.speculate === true && o.host.fetchMain !== undefined && o.client.setCandidate !== undefined && o.client.leaseState !== undefined;
}
export async function integrateOnce(o) {
    const lease = await o.client.lease(o.repoId, o.executorId, o.batchSize ?? DEFAULT_BATCH_SIZE, o.affinity === true, canSpeculate(o));
    if (!lease)
        return null;
    const stopRenewal = keepLeaseAlive(o, lease);
    try {
        return await integrateLease(o, lease);
    }
    finally {
        stopRenewal();
    }
}
/**
 * Renew the lease at half its remaining life while the batch is merged and checked, so a check that outlives the
 * lease (heavy suites take ten minutes) does not hand the batch to another integrator and waste the verification.
 */
function keepLeaseAlive(o, lease) {
    const renew = o.client.renewLease?.bind(o.client);
    if (!renew)
        return () => undefined;
    let expiresAt = lease.expiresAt;
    let timer;
    let stopped = false;
    const schedule = () => {
        if (stopped)
            return;
        const delay = Math.max(250, Math.floor((expiresAt - Date.now()) / 2));
        timer = setTimeout(() => {
            void renew(o.repoId, lease.batchId, o.executorId)
                .then((renewed) => {
                expiresAt = renewed.expiresAt;
            })
                .catch((error) => {
                console.error(`[executor ${o.executorId}] lease renewal failed: ${message(error)}`);
                // Gone (reported, expired, taken over): stop. Anything else: retry in a few seconds.
                if (error instanceof ClientError && (error.status === 404 || error.status === 409))
                    stopped = true;
                else
                    expiresAt = Date.now() + 10_000;
            })
                .finally(schedule);
        }, delay);
        timer.unref?.();
    };
    schedule();
    return () => {
        stopped = true;
        if (timer)
            clearTimeout(timer);
    };
}
/**
 * The checks of a work clone: the related check (closure-addressed when the cache has closure keys), the closure
 * context of a tree (checked out in `o.work`), and the prefix evaluator the bisection uses.
 */
function evaluatorFor(o) {
    const { work } = o;
    // An integrator needs pass or fail and the first failure, not every failure: a check that fails stops there
    // (COMMONS_CHECK_BAIL, honoured by `commons check`). The sixteenth run's one revert came from two failing checks of
    // 546 and 592 s, tests running into their timeouts one after another, where passing checks of the package took 45 to 139 s.
    const allChecks = [...o.checks, ...(o.landChecks ?? [])].map((c) => (o.failFast !== false && c instanceof CommandCheck ? c.withEnv({ COMMONS_CHECK_BAIL: "1" }) : c));
    // Closure-addressed verdicts: the first check, when it is file-scoped, is satisfied per submission from the
    // cache wherever a verdict exists for the same closure content; the command then runs only for the rest.
    const related = allChecks[0];
    const scoped = o.closureKeys !== false && related instanceof CommandCheck && related.relatedTemplate !== undefined && (o.cache.hasClosureKeys() || o.cache.hasRemote());
    const closureContexts = new Map();
    const closureContext = (commit, tree) => {
        let pending = closureContexts.get(tree);
        if (!pending) {
            pending = (async () => {
                await checkoutDetached(work, commit);
                const blobs = await blobsOf(work, tree);
                let index = null;
                try {
                    index = closureIndex(work);
                }
                catch (error) {
                    console.error(`[executor ${o.executorId}] closure index: ${message(error)}`);
                }
                return { index, blobs };
            })();
            closureContexts.set(tree, pending);
        }
        return pending;
    };
    const evaluateOn = async (list, prefix, memo) => {
        const known = memo.get(prefix);
        if (known)
            return known;
        const target = list[prefix - 1].candidate;
        const tree = await treeOf(work, target);
        const inPrefix = list.slice(0, prefix);
        const files = unique(inPrefix.flatMap((a) => a.changed.map((c) => c.path)));
        let results;
        const satisfied = [];
        if (scoped && files.length > 0) {
            const { index, blobs } = await closureContext(target, tree);
            const pending = [];
            const waits = [];
            // A failure stored for exactly this closure (the agent's pre-verification, an earlier batch) is this prefix's
            // verdict as surely as a pass would be: it is used as is, without running the same failing tests again (in the
            // fourteenth run every revert waited for a re-run of tests whose failure was already known).
            const known = [];
            for (const a of inPrefix) {
                const key = closureKey({ checkId: related.id, changedFiles: a.changed.map((c) => c.path), index, blobs });
                // A change the gate found independent of everything that landed since its fork carries its own pre-verification
                // over, though the closure key on this candidate differs.
                const carried = carriedVerdicts.get(a.submission.id) ?? null;
                const hit = (key ? await o.cache.fetch(key, related.id) : null) ?? (carried ? await o.cache.fetch(carried, related.id) : null);
                const inflight = key && o.cache.runningSince(key, related.id) !== null ? key : carried && o.cache.runningSince(carried, related.id) !== null ? carried : null;
                if (hit?.passed)
                    satisfied.push(a.submission.id);
                else if (hit)
                    known.push(hit);
                else if (inflight) {
                    // The agent's own pre-verification of exactly this closure is still running: its verdict is minutes
                    // away at most, and running the same tests here would double the load.
                    console.error(`[executor ${o.executorId}] waiting for the pre-verification of ${a.submission.taskId} (in flight for ${Math.round((Date.now() - (o.cache.runningSince(inflight, related.id) ?? Date.now())) / 1000)} s)${inflight === carried && inflight !== key ? "; independent of what landed since its fork, its verdict holds here" : ""}`);
                    waits.push(o.cache.awaitInflight(inflight, related.id, { maxMs: o.preverifyGraceMs ?? related.timeoutMs }).then((late) => {
                        if (late?.passed)
                            satisfied.push(a.submission.id);
                        else if (late)
                            known.push(late);
                        else
                            pending.push(a);
                    }));
                }
                else
                    pending.push(a);
            }
            await Promise.all(waits);
            const remaining = unique(pending.flatMap((a) => a.changed.map((c) => c.path)));
            let first;
            if (known.length > 0) {
                const failing = known[0];
                first = { ...failing, id: related.id, cached: true, excerpt: `${failing.excerpt}\n(the related tests already failed on this closure, from pre-verification or an earlier batch; not re-run)`.trim() };
            }
            else if (remaining.length === 0) {
                first = {
                    id: related.id,
                    passed: true,
                    failedTests: [],
                    excerpt: `related tests satisfied by ${satisfied.length} pre-verified submission(s)`,
                    durationMs: 0,
                    cached: true,
                };
            }
            else {
                const key = closureKey({ checkId: related.id, changedFiles: remaining, index, blobs });
                first = (await runChecks([related], o.cache, { work, commit: target, tree, changedFiles: remaining, key }))[0];
            }
            results = [first];
            if (first.passed && allChecks.length > 1) {
                results.push(...(await runChecks(allChecks.slice(1), o.cache, { work, commit: target, tree, changedFiles: files })));
            }
        }
        else {
            results = await runChecks(allChecks, o.cache, { work, commit: target, tree, changedFiles: files });
        }
        const ev = { prefix, commit: target, tree, results, passed: results.every((r) => r.passed), satisfied };
        memo.set(prefix, ev);
        return ev;
    };
    return { allChecks, related, scoped, closureContext, evaluateOn };
}
async function integrateLease(o, lease) {
    const { work, host } = o;
    const fromMain = lease.fromMain;
    await ensureWorkClone(work, host);
    await ensureCommit(work, host, fromMain);
    const items = new Map();
    const bounce = (submission, started, partial) => {
        items.set(submission.id, {
            submissionId: submission.id,
            status: "bounced",
            verdict: { passed: false, failedTests: [], conflicts: [], cached: false, durationMs: Date.now() - started, ...partial },
        });
    };
    const bounceConflict = (submission, started, conflicts) => bounce(submission, started, { conflicts, excerpt: `merge conflict in ${conflicts.map((c) => c.path).join(", ")}` });
    const resolver = o.llmResolve && (await llmResolveAvailable(o.llmResolve)) ? o.llmResolve : null;
    // Phase 1: merge onto the running candidate in lease order. Three steps, so that model resolution never
    // serializes the batch: (a) every submission is merged structurally in order, and a conflict the model may
    // resolve is parked while the candidate runs on without it; (b) the parked conflicts are resolved concurrently,
    // each against the candidate it saw; (c) the lease order is replayed: a resolution lands where its submission
    // was, and whatever was merged after a point where a resolution moved the candidate is merged again onto the
    // new one (reusing its own resolution when its conflict is unchanged, asking the model once more otherwise).
    const { allChecks, related, scoped, closureContext, evaluateOn } = evaluatorFor(o);
    const evaluations = new Map();
    /**
     * A submission whose related tests already failed on its own tree (its pre-verification, or an earlier batch
     * with the same closure content) is bounced here with that verdict: the queue never re-runs a known failure.
     */
    /** A submission's own pre-verification on its own tree: passed, failed, still running, or unknown. */
    const ownState = async (submission, commit) => {
        if (!scoped)
            return { state: "unknown" };
        try {
            await ensureCommit(work, host, submission.parentMain);
            const baseR = await gitRaw(work, ["merge-base", commit, submission.parentMain]);
            const base = baseR.code === 0 ? baseR.stdout.trim() : submission.parentMain;
            const files = (await git(work, ["diff", "--name-only", base, commit])).split("\n").filter(Boolean);
            if (files.length === 0)
                return { state: "unknown" };
            const tree = await treeOf(work, commit);
            const { index, blobs } = await closureContext(commit, tree);
            const key = closureKey({ checkId: related.id, changedFiles: files, index, blobs });
            if (!key)
                return { state: "unknown" };
            const hit = await o.cache.fetch(key, related.id);
            if (hit)
                return hit.passed ? { state: "passed", key } : { state: "failed", result: hit };
            const since = o.cache.runningSince(key, related.id);
            return since !== null ? { state: "running", since, key } : { state: "unknown" };
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] own verdict lookup for ${submission.taskId}: ${message(error)}`);
            return { state: "unknown" };
        }
    };
    /**
     * A failure is known only for trees that agree with the one it was computed on over the change's closure: an agent
     * that forked from a main an optimistic landing had broken (and that has since been reverted) failed its
     * pre-verification for someone else's change, and the candidate on today's main does not share that closure. In the
     * twelfth run two agents were bounced that way before this check compared the candidate's closure too.
     */
    const knownFailure = async (submission, commit, mergedCandidate) => {
        if (!scoped)
            return null;
        try {
            await ensureCommit(work, host, submission.parentMain);
            const baseR = await gitRaw(work, ["merge-base", commit, submission.parentMain]);
            const base = baseR.code === 0 ? baseR.stdout.trim() : submission.parentMain;
            const files = (await git(work, ["diff", "--name-only", base, commit])).split("\n").filter(Boolean);
            if (files.length === 0)
                return null;
            const tree = await treeOf(work, commit);
            const { index, blobs } = await closureContext(commit, tree);
            const key = closureKey({ checkId: related.id, changedFiles: files, index, blobs });
            const hit = key ? await o.cache.fetch(key, related.id) : null;
            if (!hit || hit.passed)
                return null;
            const candidateTree = await treeOf(work, mergedCandidate);
            if (candidateTree !== tree) {
                const there = await closureContext(mergedCandidate, candidateTree);
                if (closureKey({ checkId: related.id, changedFiles: files, index: there.index, blobs: there.blobs }) !== key)
                    return null;
            }
            return hit;
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] known-failure lookup for ${submission.taskId}: ${message(error)}`);
            return null;
        }
    };
    const slots = [];
    let candidate = fromMain;
    for (const submission of lease.submissions) {
        const started = Date.now();
        let commit;
        try {
            commit = await host.fetchTask(work, submission.taskId);
        }
        catch (error) {
            bounce(submission, started, { excerpt: `fetch failed for ${host.taskRef(submission.taskId)}: ${message(error)}` });
            continue;
        }
        if (commit !== submission.commit) {
            bounce(submission, started, {
                excerpt: `ref mismatch: ${host.taskRef(submission.taskId)} is ${commit} but the submission is ${submission.commit}`,
            });
            continue;
        }
        const merge = await mergeStructurally(o, candidate, commit, submission);
        if (merge.kind === "error") {
            bounce(submission, started, { excerpt: merge.excerpt });
            continue;
        }
        if (merge.kind === "conflict") {
            if (!resolver) {
                bounceConflict(submission, started, merge.conflict.conflicts);
                continue;
            }
            const landedSoFar = slots.flatMap((s) => (s.merged ? [s.merged] : []));
            const evidence = await resolveEvidence(work, merge.conflict, landedSoFar, submission);
            slots.push({ submission, started, conflict: merge.conflict, evidence, attempts: 0, result: null });
            continue;
        }
        const merged = await mergeCommit(work, submission, candidate, merge);
        const known = await knownFailure(submission, commit, merged.candidate);
        if (known) {
            bounce(submission, started, {
                failedTests: known.failedTests,
                cached: true,
                excerpt: `${known.excerpt}\n(the related tests already failed on this closure: ${known.failedTests.length} failing, from pre-verification or an earlier batch; not re-run)`.trim(),
            });
            continue;
        }
        slots.push({ submission, started, merged, attempts: 0, result: null });
        candidate = merged.candidate;
    }
    const accepted = [];
    const pending = slots.filter((s) => s.conflict);
    const budget = new AbortController();
    const deadline = Date.now() + (o.llmResolveBudgetMs ?? DEFAULT_LLM_RESOLVE_BUDGET_MS);
    const timer = pending.length > 0 ? setTimeout(() => budget.abort(), deadline - Date.now()) : undefined;
    const resolveOpts = { ...resolver, signal: budget.signal };
    try {
        await forEachConcurrent(pending, o.llmResolveConcurrency ?? DEFAULT_LLM_RESOLVE_CONCURRENCY, async (slot) => {
            const { conflictedTree, ours, conflicts } = slot.conflict;
            slot.attempts++;
            slot.result = await llmResolve(work, conflictedTree, ours, conflicts, resolveOpts, slot.evidence);
        });
        candidate = fromMain;
        for (const slot of slots) {
            const { submission, started } = slot;
            if (slot.merged && slot.merged.prev === candidate) {
                accepted.push(slot.merged);
                candidate = slot.merged.candidate;
                continue;
            }
            let merge;
            if (slot.conflict && slot.conflict.ours === candidate) {
                // Resolved against exactly this candidate.
                merge = slot.result ? { kind: "clean", tree: slot.result.tree, note: modelNote(slot.result) } : { kind: "conflict", conflict: slot.conflict };
            }
            else {
                // The candidate moved under this submission: merge it again onto the new one.
                merge = await mergeStructurally(o, candidate, submission.commit, submission);
                if (merge.kind === "conflict") {
                    const { conflictedTree, conflicts } = merge.conflict;
                    let result = slot.result ? await reapplyResolutions(work, conflictedTree, candidate, conflicts, slot.result.resolutions) : null;
                    if (!result && resolver && slot.attempts < MAX_MODEL_ATTEMPTS && Date.now() < deadline) {
                        slot.attempts++;
                        const evidence = await resolveEvidence(work, merge.conflict, accepted, submission);
                        result = await llmResolve(work, conflictedTree, candidate, conflicts, resolveOpts, evidence);
                    }
                    if (result)
                        merge = { kind: "clean", tree: result.tree, note: modelNote(result) };
                }
            }
            if (merge.kind === "error") {
                bounce(submission, started, { excerpt: merge.excerpt });
                continue;
            }
            if (merge.kind === "conflict") {
                bounceConflict(submission, started, merge.conflict.conflicts);
                continue;
            }
            const merged = await mergeCommit(work, submission, candidate, merge);
            accepted.push(merged);
            candidate = merged.candidate;
        }
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
    // Fast bounce: conflicts are known now; do not make them wait for the checks of the clean submissions. Not for a
    // stacked batch: its conflicts were found on a base that may never become main.
    if (o.fastBounce !== false && items.size > 0 && accepted.length > 0 && !lease.speculativeOn) {
        const result = {
            batchId: lease.batchId,
            toMain: fromMain,
            results: lease.submissions.filter((sub) => items.has(sub.id)).map((sub) => items.get(sub.id)),
            requeue: accepted.map((a) => a.submission.id),
        };
        await o.client.report(o.repoId, result);
        return result;
    }
    // Publish the merged candidate so an overlapping batch can be verified on top of it while this one is.
    if (canSpeculate(o) && accepted.length > 0) {
        const merged = accepted[accepted.length - 1].candidate;
        if (merged !== fromMain) {
            try {
                await git(work, ["push", "--quiet", "--force", host.url, `${merged}:refs/candidates/${lease.batchId}`]);
                await o.client.setCandidate(o.repoId, lease.batchId, o.executorId, merged);
            }
            catch (error) {
                console.error(`[executor ${o.executorId}] publishing the candidate of ${lease.batchId}: ${message(error)}`);
            }
        }
    }
    // Phase 2: check the combined candidate; bisect by prefix when it fails.
    const evaluate = (prefix) => evaluateOn(accepted, prefix, evaluations);
    // Optimistic landing: land now, verify after (see ExecutorOptions.optimistic).
    if (o.optimistic && o.client.settle && !lease.speculativeOn && accepted.length > 0 && items.size === 0) {
        const gate = await optimisticGate(o, accepted, ownState, closureContext);
        if (gate.bounce) {
            // The eligible prefix lands now; the submission whose own pre-verification failed is bounced with that verdict.
            const failed = accepted[gate.prefix];
            const r = gate.bounce;
            console.error(`[executor ${o.executorId}] bouncing ${failed.submission.taskId} on its own pre-verification`);
            const bounced = {
                submissionId: failed.submission.id,
                status: "bounced",
                verdict: { passed: false, failedTests: r.failedTests, conflicts: [], excerpt: `Your change failed its own pre-verification (the related checks on your commit):\n${r.excerpt}`, cached: true, durationMs: r.durationMs, preVerified: true },
            };
            const landing = accepted.slice(0, gate.prefix);
            const rest = accepted.slice(gate.prefix + 1).map((a) => a.submission.id);
            const early = landing.length > 0 ? await landOptimistically(o, lease, landing, gate.notes, rest, undefined, [bounced]) : null;
            if (early) {
                if (o.verifyWork)
                    verifyInBackground(o, landing);
                else
                    await verifyAfterLanding(o, landing, evaluateOn, allChecks);
                return early;
            }
            const handBack = { batchId: lease.batchId, toMain: fromMain, results: [bounced], requeue: lease.submissions.map((x) => x.id).filter((id) => id !== failed.submission.id) };
            try {
                await o.client.report(o.repoId, handBack);
            }
            catch (error) {
                if (!(error instanceof ClientError && error.status === 409))
                    throw error;
            }
            return handBack;
        }
        if (gate.defer) {
            // The eligible prefix lands now; the submission waiting for its own verdict is deferred, the rest requeued.
            const landing = accepted.slice(0, gate.prefix);
            const deferred = accepted[gate.prefix].submission.id;
            const rest = accepted.slice(gate.prefix).map((a) => a.submission.id);
            console.error(`[executor ${o.executorId}] deferring ${accepted[gate.prefix].submission.taskId}: ${gate.reason}`);
            const early = landing.length > 0 ? await landOptimistically(o, lease, landing, gate.notes, rest, undefined, [], [deferred]) : null;
            if (early) {
                if (o.verifyWork)
                    verifyInBackground(o, landing);
                else
                    await verifyAfterLanding(o, landing, evaluateOn, allChecks);
                return early;
            }
            const handBack = { batchId: lease.batchId, toMain: fromMain, results: [], requeue: lease.submissions.map((x) => x.id), defer: [deferred], ...(o.deferMs ? { deferMs: o.deferMs } : {}) };
            try {
                await o.client.report(o.repoId, handBack);
            }
            catch (error) {
                if (!(error instanceof ClientError && error.status === 409))
                    throw error;
            }
            return handBack;
        }
        if (gate.prefix > 0) {
            // The eligible prefix lands now; the rest goes back to the queue and is merged again onto the new main.
            const landing = accepted.slice(0, gate.prefix);
            const rest = accepted.slice(gate.prefix).map((a) => a.submission.id);
            if (rest.length)
                console.error(`[executor ${o.executorId}] landing ${landing.length} of ${accepted.length} optimistically, requeueing the rest: ${gate.reason}`);
            const early = await landOptimistically(o, lease, landing, gate.notes, rest);
            if (early) {
                if (o.verifyWork)
                    verifyInBackground(o, landing);
                else
                    await verifyAfterLanding(o, landing, evaluateOn, allChecks);
                return early;
            }
            // Another integrator moved main first: merge again onto the new main here and land on top of it.
            const again = await landAfterLostRace(o, lease, landing, rest, ownState, closureContext);
            if (again) {
                if (o.verifyWork)
                    verifyInBackground(o, again.landed);
                else
                    await verifyAfterLanding(o, again.landed, evaluateOn, allChecks);
                return again.result;
            }
            // Still not landed (it conflicts with what landed, or the gate refuses it now): the next lease merges it
            // again onto the new main and it goes through the gate again, which costs a lease instead of a check.
            const handBack = { batchId: lease.batchId, toMain: fromMain, results: [], requeue: lease.submissions.map((x) => x.id) };
            try {
                await o.client.report(o.repoId, handBack);
            }
            catch (error) {
                if (!(error instanceof ClientError && error.status === 409))
                    throw error;
            }
            return handBack;
        }
        else
            console.error(`[executor ${o.executorId}] batch ${lease.batchId.slice(0, 8)} checked before landing: ${gate.reason}`);
    }
    const total = accepted.length;
    let passing = 0; // longest prefix known to pass (0 = fromMain itself)
    let failing = total + 1; // shortest prefix known to fail
    if (total > 0) {
        const full = await evaluate(total);
        if (full.passed)
            passing = total;
        else {
            failing = total;
            while (failing - passing > 1) {
                const mid = Math.floor((passing + failing) / 2);
                if ((await evaluate(mid)).passed)
                    passing = mid;
                else
                    failing = mid;
            }
        }
    }
    const requeue = [];
    if (failing <= total && evaluations.get(failing).results.some(inconclusive)) {
        // The check ran out of time: no verdict. The batch goes back to the queue for another check; a submission whose
        // check times out a second time is bounced with that (a check that cannot finish is the agent's to know about).
        const suspect = accepted[passing].submission;
        const times = (timedOutChecks.get(suspect.id) ?? 0) + 1;
        timedOutChecks.set(suspect.id, times);
        if (times < 2) {
            console.error(`[executor ${o.executorId}] the check of ${suspect.taskId} timed out; requeueing the batch for another check`);
            const handBack = { batchId: lease.batchId, toMain: fromMain, results: [], requeue: lease.submissions.map((s) => s.id), defer: [suspect.id], ...(o.deferMs ? { deferMs: o.deferMs } : {}) };
            await o.client.report(o.repoId, handBack);
            return handBack;
        }
    }
    if (failing <= total && passing === 0 && o.optimistic && (await mayBeRed(o)) && (await mainIsRed(o, fromMain, evaluations.get(failing), allChecks))) {
        // Main itself fails these checks: an optimistic landing is being reverted by its integrator; nothing here is to blame.
        const handBack = { batchId: lease.batchId, toMain: fromMain, results: [], requeue: lease.submissions.map((s) => s.id) };
        console.error(`[executor ${o.executorId}] main ${fromMain.slice(0, 8)} fails the same checks; holding ${handBack.requeue.length} submission(s) until main moves, then requeueing instead of bouncing`);
        // Handed back at once, the batch was leased again on the same red main and failed again from the cache, in a loop
        // (the thirteenth run). It waits here, its lease renewed, until a landing or the culprit's revert moves main.
        if (host.fetchMain) {
            const deadline = Date.now() + (o.redMainWaitMs ?? 10 * 60 * 1000);
            while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, o.redMainPollMs ?? 5000));
                try {
                    if ((await host.fetchMain(work)) !== fromMain)
                        break;
                }
                catch {
                    // keep waiting
                }
            }
        }
        await o.client.report(o.repoId, handBack);
        return handBack;
    }
    if (failing <= total) {
        const culprit = accepted[passing];
        const failedEvaluation = evaluations.get(failing);
        const combinedFailed = unique(failedEvaluation.results.filter((r) => !r.passed).flatMap((r) => r.failedTests));
        let onlyFailsCombined;
        if (passing === 0) {
            onlyFailsCombined = []; // the failing prefix is already this submission alone on fromMain
        }
        else {
            const alone = await evaluateAlone(o, allChecks, fromMain, culprit.submission);
            if (alone === null)
                onlyFailsCombined = undefined;
            else if (alone.passed)
                onlyFailsCombined = combinedFailed;
            else {
                const aloneFailed = new Set(alone.results.flatMap((r) => r.failedTests));
                onlyFailsCombined = aloneFailed.size === 0 ? [] : combinedFailed.filter((t) => !aloneFailed.has(t));
            }
        }
        items.set(culprit.submission.id, {
            submissionId: culprit.submission.id,
            status: "bounced",
            verdict: verdictOf(failedEvaluation, { onlyFailsCombined }),
        });
        for (const a of accepted.slice(passing + 1))
            requeue.push(a.submission.id);
    }
    // A stacked batch: its verdicts hold if the batch below lands exactly as merged. When that batch landed but somewhere
    // else (its own push lost a race and its verdicts were carried onto a moved main), a batch with every submission
    // passing can carry its verdicts over the same way: the push below fails as not a fast-forward and the lost-race
    // path (transferAfterRace) walks the stack. Anything else goes back to the queue.
    if (lease.speculativeOn) {
        const base = await awaitBase(o, lease);
        if (base === "invalid" && (items.size > 0 || requeue.length > 0 || passing === 0)) {
            const handBack = { batchId: lease.batchId, toMain: fromMain, results: [], requeue: lease.submissions.map((s) => s.id) };
            console.error(`[executor ${o.executorId}] stacked on ${lease.speculativeOn}, which did not land as merged; requeueing ${handBack.requeue.length} submission(s)`);
            try {
                await o.client.report(o.repoId, handBack);
            }
            catch (error) {
                // The coordinator requeues a stale stacked batch and answers 409; anything else is worth a line.
                if (!(error instanceof ClientError && error.status === 409))
                    console.error(`[executor ${o.executorId}] report: ${message(error)}`);
            }
            return handBack;
        }
    }
    // Phase 3: land the passing prefix.
    const landed = accepted.slice(0, passing);
    const toMain = landed.length > 0 ? landed[landed.length - 1].candidate : fromMain;
    const landedVerdict = passing > 0
        ? verdictOf(evaluations.get(passing))
        : { passed: true, failedTests: [], conflicts: [], excerpt: "", cached: false, durationMs: 0 };
    const satisfiedIds = new Set(passing > 0 ? evaluations.get(passing).satisfied : []);
    for (const a of landed) {
        const changed = await summarize(work, a);
        items.set(a.submission.id, {
            submissionId: a.submission.id,
            status: "landed",
            verdict: {
                ...landedVerdict,
                ...(a.candidate === a.prev ? { excerpt: "already contained in main" } : {}),
                ...(satisfiedIds.has(a.submission.id) ? { preVerified: true } : {}),
            },
            toMain: a.candidate,
            changed,
        });
        // The "why" of this landing, stored with the commit itself (refs/notes/commons); never fatal.
        try {
            const annotation = o.annotate ? await o.annotate(a.submission.taskId) : null;
            await writeLandingNote(work, a.candidate === a.prev ? a.submission.commit : a.candidate, landingNoteFrom({
                submission: a.submission,
                batchId: lease.batchId,
                fromMain: a.prev,
                toMain: a.candidate,
                checks: passing > 0 ? evaluations.get(passing).results : [],
                changed,
                ...(a.resolved ? { resolved: a.resolved } : {}),
                ...(annotation ?? {}),
            }));
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] landing note for ${a.submission.taskId}: ${message(error)}`);
        }
    }
    if (toMain !== fromMain && o.footprints !== false) {
        // Footprints of the landed items on the verified tree: what each verdict depends on. One index per batch.
        try {
            await checkoutDetached(work, toMain);
            const index = closureIndex(work);
            for (const a of landed) {
                const item = items.get(a.submission.id);
                item.footprint = footprintOf(index, (item.changed ?? []).map((c) => ({ path: c.path, symbols: c.symbolsChanged })));
            }
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] footprints: ${message(error)}`);
        }
    }
    if (toMain !== fromMain) {
        try {
            await host.pushMain(work, toMain);
        }
        catch (error) {
            // Another integrator moved main first. If every landing in between is footprint-disjoint from ours, re-merge
            // onto the new main and land with the verdicts carried over; otherwise hand everything back to the queue.
            const transferred = await transferAfterRace(o, work, host, lease, landed, items, requeue);
            if (transferred)
                return transferred;
            // With optimistic landing on, a batch that passed its checks lands on top of the main that won anyway, as an
            // optimistic landing checked again in the background: requeueing it to be checked again from scratch starved a
            // wrangler change in the twelfth run (four checks of five minutes each, each losing the race to faster landings).
            if (o.optimistic && o.client.settle && !lease.speculativeOn && landed.length > 0) {
                const bounces = [...items.values()].filter((i) => i.status === "bounced");
                const again = await landAfterLostRace(o, lease, landed, requeue, ownState, closureContext, { gate: false, extra: bounces, why: "passed its checks on an earlier main" });
                if (again) {
                    if (o.verifyWork)
                        verifyInBackground(o, again.landed);
                    else
                        await verifyAfterLanding(o, again.landed, evaluateOn, allChecks);
                    return again.result;
                }
            }
            const requeueAll = lease.submissions.map((s) => s.id).filter((id) => !items.has(id) || items.get(id).status === "landed");
            const bounces = [...items.values()].filter((i) => i.status === "bounced");
            const raced = { batchId: lease.batchId, toMain: fromMain, results: lease.speculativeOn ? [] : bounces, requeue: lease.speculativeOn ? lease.submissions.map((s) => s.id) : requeueAll };
            console.error(`[executor ${o.executorId}] push lost the race (${message(error)}); requeueing ${raced.requeue.length} submission(s)`);
            try {
                await o.client.report(o.repoId, raced);
            }
            catch (reportError) {
                // A stacked batch whose base never became main is requeued by the coordinator with a 409.
                if (!(lease.speculativeOn && reportError instanceof ClientError && reportError.status === 409))
                    throw reportError;
            }
            return raced;
        }
        try {
            await pushNotes(work, host.url);
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] push notes: ${message(error)}`);
        }
    }
    const results = [];
    for (const submission of lease.submissions) {
        const item = items.get(submission.id);
        if (item)
            results.push(item);
    }
    const result = { batchId: lease.batchId, toMain, results, requeue };
    await o.client.report(o.repoId, result);
    return result;
}
/**
 * Wait until the batch a stacked lease sits on has settled: "landed" when main is exactly this lease's base (the
 * candidate below landed as merged), "invalid" when that batch was reported, went stale or expired with main
 * elsewhere, or the wait ran out.
 */
async function awaitBase(o, lease) {
    const below = lease.speculativeOn;
    const deadline = Date.now() + (o.speculationWaitMs ?? 60 * 60 * 1000);
    for (;;) {
        const main = await o.host.fetchMain(o.work);
        if (main === lease.fromMain)
            return "landed";
        let settled = false;
        try {
            settled = (await o.client.leaseState(o.repoId, below)).status !== "active";
        }
        catch (error) {
            settled = error instanceof ClientError && error.status === 404;
        }
        if (settled)
            return (await o.host.fetchMain(o.work)) === lease.fromMain ? "landed" : "invalid";
        if (Date.now() >= deadline)
            return "invalid";
        await new Promise((resolve) => setTimeout(resolve, o.speculationPollMs ?? 500));
    }
}
/**
 * After a lost push race: re-merge the verified landings onto the current main and land them without re-testing
 * when every landing that moved main in between is footprint-disjoint from each of them. Null means "cannot".
 */
async function transferAfterRace(o, work, host, lease, landed, items, requeue) {
    const decline = (why) => {
        console.error(`[executor ${o.executorId}] verdict transfer declined: ${why}`);
        return null;
    };
    if (o.footprints === false || landed.length === 0)
        return null;
    if (!host.fetchMain || !o.client.landings)
        return decline("host or client cannot report landings");
    let current;
    try {
        current = await host.fetchMain(work);
    }
    catch (error) {
        return decline(`fetch main: ${message(error)}`);
    }
    if (current === lease.fromMain)
        return decline("main did not move");
    // A stacked lease's base is another batch's candidate, never main: the chain of landings starts where the bottom of
    // the stack was leased, and the batches of the stack must all have landed on it; only the other landings in between
    // must be disjoint from this batch.
    let from = lease.fromMain;
    const stack = new Set();
    if (lease.speculativeOn) {
        if (!o.client.leaseState)
            return decline("client cannot read lease state");
        let below = lease.speculativeOn;
        for (let depth = 0; below && depth < 8; depth++) {
            let state;
            try {
                state = await o.client.leaseState(o.repoId, below);
            }
            catch (error) {
                return decline(`lease state of ${below}: ${message(error)}`);
            }
            for (const id of state.submissionIds)
                stack.add(id);
            from = state.fromMain;
            below = state.speculativeOn;
        }
    }
    for (let round = 1; round <= 3; round++) {
        // The integrator that moved main pushes before it reports; give its report a few seconds to arrive.
        let between = null;
        let known = 0;
        for (let attempt = 0; attempt < 20 && !between; attempt++) {
            if (attempt > 0)
                await new Promise((resolve) => setTimeout(resolve, 250));
            let all;
            try {
                all = await o.client.landings(o.repoId);
            }
            catch (error) {
                return decline(`landings: ${message(error)}`);
            }
            known = all.length;
            between = landingsBetween(all, from, current);
            if (between && between.length === 0)
                between = null;
            if (!between) {
                // main may have moved again while we waited; chase it.
                try {
                    current = await host.fetchMain(work);
                }
                catch (error) {
                    return decline(`fetch main: ${message(error)}`);
                }
            }
        }
        if (!between)
            return decline(`no landing chain from ${from.slice(0, 7)} to ${current.slice(0, 7)} (${known} landings known)`);
        if (stack.size > 0) {
            const landedIds = new Set(between.map((l) => l.submissionId));
            const missing = [...stack].filter((id) => !landedIds.has(id));
            if (missing.length > 0)
                return decline(`${missing.length} submission(s) of the batches below did not land`);
            between = between.filter((l) => !stack.has(l.submissionId));
        }
        for (const a of landed) {
            const fp = items.get(a.submission.id)?.footprint;
            if (!fp)
                return decline(`no footprint for ${a.submission.taskId}`);
            if (!transferable(fp, between))
                return decline(`${a.submission.taskId} overlaps a landing in between (closure ${fp.closure ? fp.closure.length + " files" : "unknown"}; ${between.map((l) => l.taskId + (l.footprint?.closure ? "" : "?")).join(",")})`);
        }
        let candidate = current;
        const updates = [];
        for (const a of landed) {
            const item = items.get(a.submission.id);
            try {
                const base = await mergeBase(work, candidate, a.submission.commit);
                const merged = await mergeTree(work, base, candidate, a.submission.commit);
                if (merged.conflicts.length > 0)
                    return decline(`re-merge of ${a.submission.taskId} conflicts`);
                const next = await commitTree(work, merged.tree, [candidate, a.submission.commit], `Land ${a.submission.taskId}: ${a.submission.summary} (verdict transferred from ${a.candidate.slice(0, 7)})`);
                // The verified tree and the re-merged tree must agree on every file the verdict depends on.
                const fp = item.footprint;
                const watched = new Set([...fp.changed, ...(fp.closure ?? [])]);
                const diff = await changedFiles(work, a.candidate, next);
                if (diff.some((d) => watched.has(d.path)))
                    return decline(`re-merged tree differs inside ${a.submission.taskId}'s footprint`);
                updates.push({ id: a.submission.id, toMain: next });
                candidate = next;
            }
            catch (error) {
                return decline(`re-merge: ${message(error)}`);
            }
        }
        try {
            await host.pushMain(work, candidate);
        }
        catch (error) {
            if (round < 3) {
                console.error(`[executor ${o.executorId}] push after re-merge lost again (round ${round}); retrying against the newest main`);
                try {
                    current = await host.fetchMain(work);
                }
                catch (error2) {
                    return decline(`fetch main: ${message(error2)}`);
                }
                continue;
            }
            return decline(`push after re-merge: ${message(error)}`);
        }
        for (const u of updates) {
            const item = items.get(u.id);
            item.toMain = u.toMain;
            item.verdict = { ...item.verdict, transferred: true };
        }
        const results = [];
        for (const submission of lease.submissions) {
            const item = items.get(submission.id);
            if (item)
                results.push(item);
        }
        const result = { batchId: lease.batchId, toMain: candidate, results, requeue, rebasedFrom: current };
        await o.client.report(o.repoId, result);
        console.error(`[executor ${o.executorId}] push lost the race; ${updates.length} verdict(s) transferred onto ${current.slice(0, 7)} across ${between.length} landing(s)`);
        return result;
    }
    return null;
}
/**
 * The conflict-risk gate of optimistic landing. A submission may land before its combined check when its own
 * pre-verification passed or is still running (a failure there is bounced before merging), and when what landed on
 * main since it forked cannot change what its tests observe: no file changed on main since the fork lies in the
 * dependency closure of its changes on the merged tree (which also catches main's new code importing what it changed).
 * `maxRisk` admits up to that many such files.
 */
async function optimisticGate(o, accepted, ownState, closureContext) {
    const maxRisk = (typeof o.optimistic === "object" ? o.optimistic.maxRisk : undefined) ?? readProfile(o.work).limits?.maxRisk ?? 0;
    const last = accepted[accepted.length - 1].candidate;
    const { index } = await closureContext(last, await treeOf(o.work, last));
    if (!index)
        return { prefix: 0, notes: [], reason: "no closure index of the merged tree" };
    const notes = [];
    // The longest eligible prefix of the batch, in lease order: what follows the first ineligible submission was merged
    // onto it and cannot land without it.
    for (const [k, a] of accepted.entries()) {
        const stop = (reason) => ({ prefix: k, notes, reason });
        const own = await ownState(a.submission, a.submission.commit);
        if (own.state === "failed" && (await forkIsSound(o, a))) {
            // Its own change fails its own tests on a main nothing unverified had touched: that is its verdict. Checking it
            // again in a batch cost two more checks in the twentieth run (on the moved main, then main without it) and
            // bounced it nine minutes after its pre-verification had failed.
            return { prefix: k, notes, reason: `${a.submission.taskId} failed its own pre-verification`, bounce: own.result };
        }
        if (own.state !== "passed" && own.state !== "running")
            return stop(`${a.submission.taskId} has no pre-verification`);
        if (a.candidate === a.prev)
            continue;
        if (own.state === "running" && readProfile(o.work).limits?.landWhileVerifying === false) {
            // Checks are fast here (the profile says so): its own verdict is a minute away, and waiting for it costs less than
            // a revert. In the third vuejs/core run six changes landed while their pre-verification ran, failed it and were
            // reverted, and their resubmissions then conflicted with each other's reverted history for a quarter of an hour.
            const young = own.since === undefined || Date.now() - own.since < (o.preverifyGraceMs ?? DEFAULT_PREVERIFY_GRACE_MS);
            if (young && own.key)
                o.cache.want(own.key, "related");
            return { ...stop(`${a.submission.taskId}'s pre-verification is still running (fast checks: land on its verdict)`), ...(young ? { defer: true } : {}) };
        }
        if (own.state === "running") {
            // A change to the exported surface of a package that other workspace packages depend on can break their builds,
            // which its own tests never see: every revert of the twelfth and thirteenth runs was one (workers-auth's error
            // codes, miniflare's options), landed while the pre-verification that would have caught it was still running.
            const surface = await surfaceAtRisk(o.work, a);
            if (surface) {
                // Its own verdict is minutes away: it waits for that in the queue (deferred), not in a checked batch that holds
                // an integrator and its scope. In the eighteenth run four such batches held all four integrators for twenty
                // minutes while ten submissions that could land waited; two of them had already failed their own checks.
                const young = own.since === undefined || Date.now() - own.since < (o.preverifyGraceMs ?? DEFAULT_PREVERIFY_GRACE_MS);
                // Someone is waiting for that verdict now: it takes a check slot with the integrators' priority (slots.ts).
                if (young && own.key)
                    o.cache.want(own.key, "related");
                return { ...stop(`${a.submission.taskId} changes the exported surface of ${surface} while its pre-verification is still running`), ...(young ? { defer: true } : {}) };
            }
        }
        const fork = await mergeBase(o.work, a.submission.commit, a.prev).catch(() => null);
        if (!fork)
            return stop(`${a.submission.taskId} has no fork point on main`);
        const onMain = fork === a.prev ? [] : (await changedFiles(o.work, fork, a.prev)).map((c) => c.path);
        let risk = 0;
        let measure = "in its closure";
        if (onMain.length > 0) {
            const closure = index.closureOf(a.changed.map((c) => ({ path: c.path })));
            if (closure === null)
                return stop(`${a.submission.taskId}'s closure is unknown`);
            const observed = new Set([...a.changed.map((c) => c.path), ...closure.map((e) => (e.includes("#") ? e.slice(0, e.indexOf("#")) : e))]);
            const closureRisk = onMain.filter((f) => observed.has(f)).length;
            risk = closureRisk;
            // Coverage first, where the base's maps can say (interaction.ts): the change and what landed since its fork
            // interact only through tests that execute code both changed. It catches what import closures miss (two packages'
            // changes meeting in a third package's test: two of the three interacting pairs of the twenty-second run) and
            // leaves alone what they over-count.
            const records = recordsDirOf(o.work);
            const mine = impactOf(o.work, fork, a.submission.commit, records);
            const theirs = mine ? impactOf(o.work, fork, a.prev, records) : null;
            const shared = mine && theirs ? sharedTests(mine, theirs) : "unknown";
            if (shared !== "unknown") {
                risk = shared.size;
                measure = `share test files with it by coverage (${closureRisk} in its closure)`;
                // Independent by coverage, and no exported signature changed on either side within its closure (a type error
                // is no test's to see): its own verdict on its fork is its verdict on main, though its closure moved, and no
                // check of it there is needed (see evaluatorFor). Where the closure did not move, the closure key carries it anyway.
                if (shared.size === 0 && closureRisk > 0 && (own.state === "passed" || own.state === "running") && own.key) {
                    const ownContracts = (await summarize(o.work, a)).some((c) => c.contractChanges.length > 0);
                    const moved = onMain.filter((f) => observed.has(f) && CODE_FILE.test(f));
                    const theirContracts = (await contractChangesBetween(o.work, fork, a.prev, moved)).length > 0;
                    if (!ownContracts && !theirContracts)
                        carriedVerdicts.set(a.submission.id, own.key);
                }
            }
        }
        if (risk > maxRisk)
            return stop(`${a.submission.taskId}: ${risk} file(s) changed on main since its fork ${measure}`);
        notes.push(`${a.submission.taskId}: pre-verification ${own.state}, ${onMain.length} file(s) changed on main since its fork, ${risk} ${measure}${carriedVerdicts.has(a.submission.id) ? "; its verdict holds on main" : ""}`);
    }
    return { prefix: accepted.length, notes };
}
const dependedOn = new Map();
/** Package directories that other workspace packages depend on, with their names, per work clone (read once). */
function packagesWithDependents(work) {
    let known = dependedOn.get(work);
    if (!known) {
        known = new Map();
        const packages = workspacePackages(work);
        for (const p of packages)
            if (directDependents(packages, p.name).length > 0)
                known.set(p.dir, p.name);
        dependedOn.set(work, known);
    }
    return known;
}
/** The name of a depended-on package whose exported signatures the change alters, or null. */
async function surfaceAtRisk(work, a) {
    const libraries = packagesWithDependents(work);
    if (libraries.size === 0)
        return null;
    for (const c of await summarize(work, a)) {
        if (c.contractChanges.length === 0)
            continue;
        for (const [dir, name] of libraries)
            if (c.path.startsWith(`${dir}/`))
                return name;
    }
    return null;
}
/** Land a merged batch on main before its combined check, and report it with optimistic verdicts. Null when the push lost a race. */
/**
 * An optimistic push that lost the race: wait until the coordinator knows the main that won (its integrator pushes
 * before it reports), merge the batch again onto it, run the gate again, and land on top of it, reporting the landing
 * as rebased onto that main. Up to four rounds when main keeps moving; null when the batch no longer merges cleanly,
 * the gate refuses it, or the coordinator does not learn of the new main in time.
 */
async function landAfterLostRace(o, lease, landing, requeue, ownState, closureContext, opts = {}) {
    const { work, host } = o;
    if (!host.fetchMain || !o.client.landings)
        return null;
    try {
        let current = await host.fetchMain(work);
        for (let round = 1; round <= 4; round++) {
            let known = false;
            for (let attempt = 0; attempt < 20 && !known; attempt++) {
                if (attempt > 0) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    current = await host.fetchMain(work);
                }
                known = landingsBetween(await o.client.landings(o.repoId), lease.fromMain, current) !== null;
            }
            if (!known)
                return null;
            let candidate = current;
            const rebuilt = [];
            for (const a of landing) {
                const merge = await mergeStructurally(o, candidate, a.submission.commit, a.submission);
                if (merge.kind === "error" || merge.kind === "conflict")
                    return null;
                const merged = await mergeCommit(work, a.submission, candidate, merge);
                rebuilt.push(merged);
                candidate = merged.candidate;
            }
            let notes = [opts.why ?? ""];
            if (opts.gate !== false) {
                const gate = await optimisticGate(o, rebuilt, ownState, closureContext);
                if (gate.prefix < rebuilt.length)
                    return null;
                notes = gate.notes;
            }
            const result = await landOptimistically(o, lease, rebuilt, notes, requeue, current, opts.extra ?? []);
            if (result) {
                console.error(`[executor ${o.executorId}] landed after losing the race, on ${current.slice(0, 8)} (round ${round})`);
                return { result, landed: rebuilt, base: current };
            }
            current = await host.fetchMain(work);
        }
    }
    catch (error) {
        console.error(`[executor ${o.executorId}] landing after a lost race: ${message(error)}`);
    }
    return null;
}
async function landOptimistically(o, lease, accepted, notes, requeue = [], rebasedFrom, extra = [], defer = []) {
    const { work, host } = o;
    const toMain = accepted[accepted.length - 1].candidate;
    const results = [...extra];
    for (const a of accepted) {
        const changed = await summarize(work, a);
        results.push({
            submissionId: a.submission.id,
            status: "landed",
            verdict: {
                passed: true,
                failedTests: [],
                conflicts: [],
                excerpt: a.candidate === a.prev ? "already contained in main" : "landed before its combined check (optimistic landing); the check runs now, and a failure reverts it on main",
                cached: false,
                durationMs: 0,
                optimistic: true,
            },
            toMain: a.candidate,
            changed,
        });
    }
    if (o.footprints !== false) {
        try {
            await checkoutDetached(work, toMain);
            const index = closureIndex(work);
            for (const item of results)
                if (item.status === "landed")
                    item.footprint = footprintOf(index, (item.changed ?? []).map((c) => ({ path: c.path, symbols: c.symbolsChanged })));
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] footprints: ${message(error)}`);
        }
    }
    try {
        await host.pushMain(work, toMain);
    }
    catch (error) {
        console.error(`[executor ${o.executorId}] optimistic push lost the race (${message(error).split("\n")[0]})`);
        return null;
    }
    for (const a of accepted) {
        try {
            const annotation = o.annotate ? await o.annotate(a.submission.taskId) : null;
            await writeLandingNote(work, a.candidate === a.prev ? a.submission.commit : a.candidate, landingNoteFrom({ submission: a.submission, batchId: lease.batchId, fromMain: a.prev, toMain: a.candidate, checks: [], changed: results.find((r) => r.submissionId === a.submission.id)?.changed ?? [], ...(a.resolved ? { resolved: a.resolved } : {}), ...(annotation ?? {}) }));
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] landing note for ${a.submission.taskId}: ${message(error)}`);
        }
    }
    try {
        await pushNotes(work, host.url);
    }
    catch (error) {
        console.error(`[executor ${o.executorId}] push notes: ${message(error)}`);
    }
    const result = { batchId: lease.batchId, toMain, results, requeue, ...(rebasedFrom ? { rebasedFrom } : {}), ...(defer.length > 0 ? { defer, ...(o.deferMs ? { deferMs: o.deferMs } : {}) } : {}) };
    console.error(`[executor ${o.executorId}] landed ${accepted.length} submission(s) optimistically: ${notes.join("; ")}`);
    await o.client.report(o.repoId, result);
    return result;
}
/**
 * The combined check of optimistic landings, run after they landed: the landings of one batch, or of a lane (several
 * batches, possibly of several integrators, in landing order). Bisects like the queue does before landing; the passing
 * prefix is settled as verified, the culprit is reverted on main (on top of whatever landed since) and bounced to its
 * agent, and what came after the culprit is merged again without it and checked the same way. `ownerOf` names the
 * integrator a landing is settled for (default `o`). With `requeue` (the shared verifier), landings that cannot be
 * judged now go back to it instead: those checked on a main that already failed without them ("red"; settling them as
 * verified let a broken landing through in the nineteenth run, five landings of one lane at once), and those that came
 * after a culprit ("tail"), checked again later on the main its revert produced.
 */
async function verifyAfterLanding(o, landed, evaluateOn, checks, ownerOf = () => o, requeue, original = (a) => a) {
    if (landed.length === 0)
        return;
    let list = landed;
    let base = landed[0].prev;
    let memo = new Map();
    // A rebuilt or re-targeted chain is only for checking; what is reverted on main is always the landing as it happened.
    const asLanded = new Map(landed.map((a) => [a.submission.id, original(a)]));
    const owner = (a) => ownerOf(asLanded.get(a.submission.id) ?? a);
    for (let round = 0; list.length > 0 && round <= landed.length; round++) {
        const total = list.length;
        let passing = 0;
        let failing = total + 1;
        const full = await evaluateOn(list, total, memo);
        if (full.passed)
            passing = total;
        else {
            failing = total;
            // Blame by coverage before bisecting: when the failing tests executed the changed code of exactly one landing,
            // check the main just before it and the main with it (two checks, often cached) instead of log2(n).
            const suspect = total > 2 ? blameByCoverage(o, list, full) : -1;
            if (suspect >= 0) {
                const before = suspect === 0 ? null : await evaluateOn(list, suspect, memo);
                const at = await evaluateOn(list, suspect + 1, memo);
                if ((before === null || before.passed) && !at.passed) {
                    passing = suspect;
                    failing = suspect + 1;
                    console.error(`[executor ${o.executorId}] blamed ${list[suspect].submission.taskId} by coverage among ${total} landings`);
                }
            }
            while (failing - passing > 1) {
                const mid = Math.floor((passing + failing) / 2);
                if ((await evaluateOn(list, mid, memo)).passed)
                    passing = mid;
                else
                    failing = mid;
            }
        }
        for (const a of list.slice(0, passing))
            await settle(owner(a), { submissionId: a.submission.id, executorId: owner(a).executorId, outcome: "verified" });
        if (failing > total)
            return;
        const failed = memo.get(failing);
        const suspect = list[passing];
        if (failed.results.some(inconclusive)) {
            // The check ran out of time: nothing is known about these landings, and a revert would hand an agent a failure
            // that is not its own. Check them again later.
            const rest = list.slice(passing).map((a) => asLanded.get(a.submission.id) ?? a);
            if (requeue) {
                console.error(`[executor ${o.executorId}] the check of ${suspect.submission.taskId} timed out; holding ${rest.length} landing(s) for another check`);
                await requeue(rest, "red");
                return;
            }
            console.error(`[executor ${o.executorId}] the check of ${suspect.submission.taskId} timed out; settling ${rest.length} landing(s) as verified`);
            for (const a of rest)
                await settle(owner(a), { submissionId: a.submission.id, executorId: owner(a).executorId, outcome: "verified" });
            return;
        }
        // Main just before the suspect: the base for the first landing, and for a later one wherever other landings came in
        // between (a lane spans batches). When main already fails the same checks there, the culprit landed elsewhere and
        // its own lane reverts it; these landings are not what broke main.
        const before = passing === 0 ? base : list[passing - 1].candidate;
        if ((passing === 0 || suspect.prev !== before) && (await mainIsRed(o, suspect.prev, failed, checks))) {
            const rest = list.slice(passing).map((a) => asLanded.get(a.submission.id) ?? a);
            if (requeue) {
                console.error(`[executor ${o.executorId}] ${suspect.prev.slice(0, 8)} fails the same checks without ${suspect.submission.taskId}; holding ${rest.length} landing(s) until main is repaired`);
                await requeue(rest, "red");
                return;
            }
            console.error(`[executor ${o.executorId}] ${suspect.prev.slice(0, 8)} fails the same checks without ${suspect.submission.taskId}; settling ${rest.length} landing(s) as verified`);
            for (const a of rest)
                await settle(owner(a), { submissionId: a.submission.id, executorId: owner(a).executorId, outcome: "verified" });
            return;
        }
        const culprit = asLanded.get(suspect.submission.id);
        const verdict = verdictOf(failed);
        const revert = await revertLanding(o, culprit, verdict);
        const excerpt = `Your change landed on main before its combined check (optimistic landing), and that check then failed on main` +
            (revert ? `; it was reverted from main by ${revert.commit.slice(0, 12)}.` : `; reverting it conflicted with later landings, so main still contains it.`) +
            ` Fix the failure, make a NEW commit on top of your branch, and submit again.\n\n${verdict.excerpt}`;
        await settle(owner(culprit), { submissionId: culprit.submission.id, executorId: owner(culprit).executorId, outcome: "reverted", verdict: { ...verdict, excerpt }, revert, prevMain: culprit.prev, landed: culprit.candidate });
        // What came after the culprit was only ever checked together with it: check it again without, on the main the revert
        // produced (shared verifier), or merged again without it here.
        const tail = list.slice(passing + 1);
        if (requeue && revert) {
            if (tail.length > 0)
                await requeue(tail.map((a) => asLanded.get(a.submission.id) ?? a), "tail");
            return;
        }
        let candidate = before;
        base = candidate;
        const rebuilt = [];
        for (const a of tail) {
            const merge = await mergeStructurally(o, candidate, a.submission.commit, a.submission);
            if (merge.kind !== "clean" && merge.kind !== "noop") {
                // It does not merge without the culprit: it built on it. Leave it on main; the culprit's fix comes back through the queue.
                await settle(owner(a), { submissionId: a.submission.id, executorId: owner(a).executorId, outcome: "verified" });
                continue;
            }
            const merged = await mergeCommit(o.work, a.submission, candidate, merge);
            rebuilt.push(merged);
            candidate = merged.candidate;
        }
        list = rebuilt;
        memo = new Map();
    }
}
/**
 * The one landing of `list` whose changed code the failing tests of `failed` executed (by the base's coverage maps), or
 * -1 when none or several did, or no map can say.
 */
function blameByCoverage(o, list, failed) {
    try {
        const files = failingTestFiles(unique(failed.results.flatMap((r) => r.failedTests)));
        if (files.length === 0)
            return -1;
        const records = recordsDirOf(o.work);
        let found = -1;
        for (const [k, a] of list.entries()) {
            const impact = impactOf(o.work, a.prev, a.candidate, records);
            if (!impact || impact.wildcard.size > 0)
                return -1;
            const hit = [...impact.tests].some((t) => files.some((f) => t.endsWith(`::${f}`) || t.endsWith(`/${f}`)));
            if (!hit)
                continue;
            if (found >= 0)
                return -1;
            found = k;
        }
        return found;
    }
    catch {
        return -1;
    }
}
const verifiers = new Map();
/** Landings one lane check takes at most: a failure costs about log2 of this many extra checks to bisect. */
const MAX_LANE = 6;
/** A landing held for a red main is checked again after this long (a check of an unchanged main is a cache hit)... */
const HOLD_MS = 60_000;
/** ...at most this many times; after that it is settled as verified, as before holding existed. */
const MAX_HOLDS = 15;
function verifierOf(o) {
    let v = verifiers.get(o.host.url);
    if (!v) {
        v = { pending: [], running: [], free: [], contributed: new Set(), active: new Set(), outstanding: new Map() };
        verifiers.set(o.host.url, v);
    }
    if (o.verifyWork && !v.contributed.has(o.executorId)) {
        v.contributed.add(o.executorId);
        for (const work of Array.isArray(o.verifyWork) ? o.verifyWork : [o.verifyWork])
            v.free.push({ work, host: o.verifyHost ?? o.host });
    }
    return v;
}
function track(v, job) {
    v.active.add(job);
    void job.finally(() => v.active.delete(job));
}
function account(v, executorId, delta) {
    v.outstanding.set(executorId, (v.outstanding.get(executorId) ?? 0) + delta);
}
/**
 * Queue the combined check of an optimistic landing: it runs on a verification clone off the integration loop (the
 * integrator leases and lands the next batch meanwhile), together with the other landings of its lane that are waiting
 * then (see lanes.ts).
 */
function verifyInBackground(o, landed) {
    const v = verifierOf(o);
    account(v, o.executorId, landed.length);
    track(v, (async () => {
        for (const a of landed) {
            try {
                if (a.candidate === a.prev) {
                    // Already contained in main: nothing of its own to check.
                    await settle(o, { submissionId: a.submission.id, executorId: o.executorId, outcome: "verified" });
                    account(v, o.executorId, -1);
                    continue;
                }
                const depth = Number(await git(o.work, ["rev-list", "--count", a.candidate]));
                v.pending.push({ owner: o, landed: a, packages: lanesOf(o.work, a.changed.map((c) => c.path)), depth });
            }
            catch (error) {
                console.error(`[executor ${o.executorId}] queueing the verification of ${a.submission.taskId}: ${message(error)}`);
                account(v, o.executorId, -1);
            }
        }
        // Landing order on main (pushes are fast-forwards, so a later landing has the deeper history).
        v.pending.sort((x, y) => x.depth - y.depth);
        pump(v);
    })());
}
/** Start lane checks while clones are free and some lane is waiting and not already being checked. */
function pump(v) {
    while (v.free.length > 0) {
        const now = Date.now();
        const ready = v.pending.filter((e) => (e.notBefore ?? 0) <= now);
        const lane = nextLane(ready, v.running, ready[0] ? (readProfile(ready[0].owner.work).limits?.maxLane ?? MAX_LANE) : MAX_LANE);
        if (!lane)
            return;
        v.pending = v.pending.filter((e) => !lane.includes(e));
        const clone = v.free.shift();
        const packages = unique(lane.flatMap((e) => e.packages));
        v.running.push(packages);
        track(v, (async () => {
            const o = lane[0].owner;
            try {
                const vo = { ...o, work: await clone.work, host: clone.host };
                await ensureWorkClone(vo.work, vo.host);
                await ensureCommit(vo.work, vo.host, lane[lane.length - 1].landed.candidate);
                // Requeued landings are checked on main as it is now, which has every one of them (and the reverts since),
                // against that main with each undone.
                const tip = lane.some((e) => e.retarget) && vo.host.fetchMain ? await vo.host.fetchMain(vo.work) : null;
                const list = [];
                for (const e of lane) {
                    if (!e.retarget || !tip)
                        list.push(e.landed);
                    else
                        list.push({ ...e.landed, candidate: tip, prev: (await withoutLanding(vo, e.landed, tip)) ?? e.landed.prev });
                }
                const { evaluateOn, allChecks } = evaluatorFor(vo);
                if (lane.length > 1)
                    console.error(`[executor ${o.executorId}] checking ${lane.length} landings of ${packages.join(", ")} together: ${lane.map((e) => e.landed.submission.taskId).join(", ")}`);
                const byId = new Map(lane.map((e) => [e.landed.submission.id, e]));
                const requeue = async (entries, why) => {
                    for (const a of entries) {
                        const e = byId.get(a.submission.id);
                        if (!e)
                            continue;
                        const holds = (e.holds ?? 0) + (why === "red" ? 1 : 0);
                        if (holds > MAX_HOLDS) {
                            console.error(`[executor ${o.executorId}] main stayed red for ${a.submission.taskId}'s check ${MAX_HOLDS} times; settling it as verified`);
                            await settle(e.owner, { submissionId: a.submission.id, executorId: e.owner.executorId, outcome: "verified" });
                            continue;
                        }
                        v.pending.push({ ...e, retarget: true, holds, depth: Number.MAX_SAFE_INTEGER, ...(why === "red" ? { notBefore: Date.now() + (o.verifyHoldMs ?? HOLD_MS) } : {}) });
                        account(v, e.owner.executorId, 1);
                    }
                    v.pending.sort((x, y) => x.depth - y.depth);
                    if (why === "red")
                        track(v, new Promise((resolve) => setTimeout(() => (pump(v), resolve()), (o.verifyHoldMs ?? HOLD_MS) + 50)));
                };
                await verifyAfterLanding(vo, list, evaluateOn, allChecks, (a) => byId.get(a.submission.id)?.owner ?? o, requeue, (a) => byId.get(a.submission.id)?.landed ?? a);
            }
            catch (error) {
                console.error(`[executor ${o.executorId}] background verification of ${lane.map((e) => e.landed.submission.taskId).join(", ")}: ${message(error)}`);
            }
            finally {
                v.running.splice(v.running.indexOf(packages), 1);
                v.free.push(clone);
                for (const e of lane)
                    account(v, e.owner.executorId, -1);
                pump(v);
            }
        })());
    }
}
/** Main as it is with one landing undone: a commit on `onto` (null when the undo conflicts with what landed since). */
async function withoutLanding(o, landed, onto) {
    const { work } = o;
    try {
        const undo = await commitTree(work, await treeOf(work, landed.prev), [landed.candidate], `undo ${landed.submission.taskId}`);
        const merged = await mergeTree(work, landed.candidate, onto, undo);
        if (merged.conflicts.length > 0)
            return null;
        return await commitTree(work, merged.tree, [onto], `${onto.slice(0, 8)} without ${landed.submission.taskId}`);
    }
    catch (error) {
        console.error(`[executor ${o.executorId}] main without ${landed.submission.taskId}: ${message(error)}`);
        return null;
    }
}
/** Wait until every landing an integrator queued for a post-landing check has been checked. */
export async function verificationsSettled(executorId) {
    for (const v of verifiers.values()) {
        while ((v.outstanding.get(executorId) ?? 0) > 0 && v.active.size > 0)
            await Promise.race([...v.active]);
    }
}
async function settle(o, s) {
    try {
        await o.client.settle(o.repoId, s);
    }
    catch (error) {
        console.error(`[executor ${o.executorId}] settle ${s.outcome} ${s.submissionId}: ${message(error)}`);
    }
}
/**
 * Whether the main a submission forked from can be trusted to have been green: it contains no optimistic landing that is
 * still unverified, nor one reverted after the fork. False when the coordinator cannot say.
 */
async function forkIsSound(o, a) {
    if (!o.client.unsettled)
        return false;
    try {
        const fork = await mergeBase(o.work, a.submission.commit, a.prev);
        for (const u of await o.client.unsettled(o.repoId)) {
            if (u.submissionId === a.submission.id)
                continue;
            if (!(await hasCommit(o.work, u.landed)) || !(await isAncestor(o.work, u.landed, fork)))
                continue;
            if (u.revert && (await hasCommit(o.work, u.revert)) && (await isAncestor(o.work, u.revert, fork)))
                continue;
            return false;
        }
        return true;
    }
    catch (error) {
        console.error(`[executor ${o.executorId}] fork of ${a.submission.taskId}: ${message(error)}`);
        return false;
    }
}
/**
 * Whether main can be red at all: only an optimistic landing not yet verified can have broken it (everything else
 * passed its checks before landing). Asking costs one request; the check it saves (mainIsRed) runs the failing tests
 * again on main, minutes for a change that failed its own pre-verification.
 */
async function mayBeRed(o) {
    if (!o.client.metrics)
        return true;
    try {
        return ((await o.client.metrics(o.repoId)).unverified ?? 1) > 0;
    }
    catch {
        return true;
    }
}
/** Whether `base` itself fails the checks that failed on a candidate built on it (same scoped files). */
async function mainIsRed(o, base, failed, checks) {
    try {
        const files = unique((await changedFiles(o.work, base, failed.commit)).map((c) => c.path));
        const tree = await treeOf(o.work, base);
        const results = await runChecks(checks.slice(0, 1), o.cache, { work: o.work, commit: base, tree, changedFiles: files });
        const failedTests = new Set(failed.results.flatMap((r) => r.failedTests));
        const baseFailed = results.flatMap((r) => r.failedTests);
        // Red when the base fails too, and (when both name tests) on at least one of the same tests.
        return results.some((r) => !r.passed) && (failedTests.size === 0 || baseFailed.length === 0 || baseFailed.some((t) => failedTests.has(t)));
    }
    catch (error) {
        console.error(`[executor ${o.executorId}] red-main check on ${base.slice(0, 8)}: ${message(error)}`);
        return false;
    }
}
/**
 * Undo a landing on the host's current main: a commit whose parent is main and whose tree is main with the landing's
 * changes taken out (a three-way merge of main with "the landing undone", whose merge base is the landing). Retries a
 * lost push race on the new main. Null when the undo conflicts with what landed since.
 */
async function revertLanding(o, culprit, verdict) {
    const { work, host } = o;
    if (culprit.candidate === culprit.prev)
        return null;
    const undo = await commitTree(work, await treeOf(work, culprit.prev), [culprit.candidate], `undo ${culprit.submission.taskId}`);
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const main = host.fetchMain ? await host.fetchMain(work) : await git(work, ["rev-parse", "--verify", `${HOST_MAIN_REF}^{commit}`]);
            const merged = await mergeTree(work, culprit.candidate, main, undo);
            if (merged.conflicts.length > 0) {
                console.error(`[executor ${o.executorId}] reverting ${culprit.submission.taskId} conflicts with later landings in ${merged.conflicts.map((c) => c.path).join(", ")}`);
                return null;
            }
            const failing = verdict.failedTests.slice(0, 5).join(", ");
            const commit = await commitTree(work, merged.tree, [main], `Revert ${culprit.submission.taskId}: its combined check failed after an optimistic landing${failing ? ` (${failing})` : ""}`);
            await host.pushMain(work, commit);
            const changed = (await changedFiles(work, main, commit)).map((c) => ({ path: c.path, status: c.status, symbolsChanged: [], contractChanges: [] }));
            console.error(`[executor ${o.executorId}] reverted ${culprit.submission.taskId} on main: ${commit.slice(0, 8)}`);
            return { commit, fromMain: main, changed };
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] revert of ${culprit.submission.taskId}, attempt ${attempt + 1}: ${message(error)}`);
        }
    }
    return null;
}
/** Check a submission merged onto fromMain by itself. Null when it cannot be merged alone. */
async function evaluateAlone(o, checks, fromMain, submission) {
    const { work } = o;
    let inputs;
    try {
        inputs = await mergeInputs(o, fromMain, submission.commit, submission);
    }
    catch {
        return null;
    }
    const merged = await mergeTree(work, inputs.base, fromMain, inputs.theirs);
    if (merged.conflicts.length > 0)
        return null;
    const commit = await commitTree(work, merged.tree, [fromMain, submission.commit], `Check alone ${submission.taskId}: ${submission.summary}`);
    const tree = await treeOf(work, commit);
    const files = (await changedFiles(work, fromMain, commit)).map((c) => c.path);
    const results = await runChecks(checks, o.cache, { work, commit, tree, changedFiles: files });
    return { prefix: 1, commit, tree, results, passed: results.every((r) => r.passed), satisfied: [] };
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
/** Poll for leases until `signal` aborts. Errors are logged per iteration and never stop the loop. */
export async function runExecutor(o, opts) {
    const summary = { executorCostUsd: 0, resolverCalls: 0 };
    const resolver = o.llmResolve;
    const accounted = resolver ? {
        ...o,
        llmResolve: {
            ...resolver,
            onUsage: (usage) => {
                summary.executorCostUsd += usage.costUsd;
                summary.resolverCalls++;
                resolver.onUsage?.(usage);
            },
        },
    } : o;
    // Its verification clones join the host's shared pool now, not at its first optimistic landing.
    if (o.verifyWork)
        verifierOf(o);
    while (!opts.signal.aborted) {
        let busy = false;
        try {
            busy = (await integrateOnce(accounted)) !== null;
        }
        catch (error) {
            console.error(`[executor ${o.executorId}] ${message(error)}`);
        }
        if (busy)
            continue;
        await sleep(opts.pollMs, opts.signal);
    }
    await verificationsSettled(o.executorId);
    return summary;
}
//# sourceMappingURL=executor.js.map