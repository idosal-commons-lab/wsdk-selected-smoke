// Runtime-agnostic coordinator: plan, admit, queue, lease, land, delta, metrics.
// Every mutation runs inside one sql.transaction and emits events with a per-repo seq.
import { plan as planTasks, scopesIntersect } from "./planner.js";
import { Store, toTask } from "./store.js";
export class CoordinatorError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "CoordinatorError";
    }
}
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_DEFER_MS = 30_000;
const TASK_STATUSES = [
    "planned",
    "admitted",
    "blocked",
    "working",
    "submitted",
    "integrating",
    "bounced",
    "landed",
    "abandoned",
];
const SUBMISSION_STATUSES = ["queued", "leased", "landed", "bounced", "superseded"];
/** Tasks that may be touching the tree right now: they take part in dynamic admission and appear as neighbors. */
const ACTIVE = new Set(["admitted", "working", "submitted", "integrating", "bounced"]);
/** Terminal states: never block anyone, never planned again. */
const DONE = new Set(["landed", "abandoned"]);
/** Tasks that have handed a commit to the queue (pipeline mode releases their blocked neighbors). */
const SUBMITTED = new Set(["submitted", "integrating", "bounced", "landed"]);
/** States in which a claim may change the task's admission status. */
const CLAIMABLE = new Set(["planned", "admitted", "blocked", "working", "bounced"]);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export class Coordinator {
    sql;
    store;
    now;
    newId;
    leaseMs;
    /** Deferred submissions (`repoId\0submissionId`) and until when; a hint, so it lives in memory only. */
    deferredUntil = new Map();
    constructor(sql, opts = {}) {
        this.sql = sql;
        this.store = new Store(sql);
        this.now = opts.now ?? (() => Date.now());
        this.newId = opts.id ?? (() => crypto.randomUUID());
        this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
        this.store.migrate();
    }
    // ---- repos -----------------------------------------------------------------
    createRepo(input) {
        return this.sql.transaction(() => {
            const id = input.id ?? this.newId();
            if (this.store.getRepo(id))
                throw new CoordinatorError(409, `repo ${id} already exists`);
            const repo = {
                id,
                name: input.name,
                mainCommit: input.mainCommit,
                testCommand: input.testCommand,
                privacy: input.privacy ?? "plain",
                admission: input.admission ?? "overlaps",
                window: Math.max(1, input.window ?? 1),
                windowPolicy: input.windowPolicy ?? "fixed",
                windowMax: Math.max(1, input.windowMax ?? 4),
                createdAt: this.now(),
            };
            if (input.relatedTestCommand !== undefined)
                repo.relatedTestCommand = input.relatedTestCommand;
            this.store.insertRepo(repo);
            this.emit(id, "repo.created", {
                payload: { name: repo.name, mainCommit: repo.mainCommit, admission: repo.admission, privacy: repo.privacy },
            });
            return repo;
        });
    }
    getRepo(repoId) {
        return this.requireRepo(repoId);
    }
    // ---- tasks -----------------------------------------------------------------
    addTasks(repoId, inputs) {
        return this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            const seen = new Set(this.store.listTasks(repoId).map((t) => t.id));
            let ord = this.store.nextOrd(repoId);
            const at = this.now();
            const out = [];
            for (const input of inputs) {
                const id = input.id ?? this.newId();
                if (seen.has(id))
                    throw new CoordinatorError(409, `task ${id} already exists`);
                seen.add(id);
                const row = {
                    id,
                    repoId,
                    title: input.title,
                    body: input.body,
                    ...(input.kind ? { kind: input.kind } : {}),
                    status: "planned",
                    writes: input.writes ?? [],
                    reads: input.reads ?? [],
                    dependsOn: input.dependsOn ?? [],
                    rank: ord,
                    batch: 0,
                    blockedBy: [],
                    baseCommit: repo.mainCommit,
                    createdAt: at,
                    updatedAt: at,
                    ord,
                    producers: (input.dependsOn ?? []).filter((d) => d !== id),
                };
                ord++;
                this.store.insertTask(row);
                this.emit(repoId, "task.created", {
                    taskId: id,
                    payload: { title: row.title, writes: row.writes, reads: row.reads, dependsOn: row.dependsOn, baseCommit: row.baseCommit },
                });
                out.push(toTask(row));
            }
            return out;
        });
    }
    listTasks(repoId) {
        this.requireRepo(repoId);
        return this.store.listTasks(repoId).map(toTask);
    }
    /** Runs the planner over every non-terminal task. planned|blocked -> admitted|blocked; active tasks keep their status. */
    plan(repoId) {
        return this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            const all = this.store.listTasks(repoId);
            const input = all
                .filter((t) => !DONE.has(t.status))
                .map((t) => ({ id: t.id, writes: t.writes, reads: t.reads, dependsOn: t.dependsOn, order: t.ord }));
            const output = planTasks(input, repo.admission);
            const byId = new Map(all.map((t) => [t.id, t]));
            const at = this.now();
            for (const o of output) {
                const task = byId.get(o.id);
                const prevStatus = task.status;
                const prevBlockedBy = task.blockedBy;
                task.rank = o.rank;
                task.batch = o.batch;
                task.producers = o.producers;
                if (task.status === "planned" || task.status === "blocked") {
                    task.blockedBy = o.blockedBy;
                    task.status = o.blockedBy.length > 0 ? "blocked" : "admitted";
                }
                else {
                    task.blockedBy = [];
                }
                task.updatedAt = at;
                this.store.updateTask(task);
                if (task.status !== prevStatus || !sameList(prevBlockedBy, task.blockedBy))
                    this.emitAdmission(repoId, task);
            }
            // Apply the admission window (pipeline/overlaps): tasks with fewer unreleased blockers than the window start now.
            this.readmit(repoId, this.now());
            return this.store.listTasks(repoId).map(toTask);
        });
    }
    /** The runner records the actual fork before the first brief/claim/submit; retries retain it. */
    setTaskBase(repoId, taskId, baseCommit) {
        return this.sql.transaction(() => {
            this.requireRepo(repoId);
            const task = this.requireTask(repoId, taskId);
            if (task.baseCommit === baseCommit)
                return toTask(task);
            if (!["planned", "admitted", "blocked"].includes(task.status) || this.store.claimCount(repoId, taskId) || this.store.listSubmissions(repoId, taskId).length) {
                throw new CoordinatorError(409, `task ${taskId} has already started; its base cannot change`);
            }
            task.baseCommit = baseCommit;
            task.updatedAt = this.now();
            this.store.updateTask(task);
            this.emit(repoId, "task.forked", { taskId, payload: { baseCommit } });
            return toTask(task);
        });
    }
    /** Marks an admitted task as working (emits task.started once) and returns what the brief renderer needs. */
    briefMeta(repoId, taskId) {
        return this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            const task = this.requireTask(repoId, taskId);
            if (task.status === "admitted") {
                task.status = "working";
                task.updatedAt = this.now();
                this.store.updateTask(task);
                this.emit(repoId, "task.started", { taskId, payload: { baseCommit: task.baseCommit } });
            }
            const all = this.store.listTasks(repoId);
            const byId = new Map(all.map((t) => [t.id, t]));
            const blockedBy = task.blockedBy
                .map((id) => byId.get(id))
                .filter((t) => t !== undefined)
                .map((t) => ({ id: t.id, title: t.title }));
            const depIds = [...new Set([...task.producers, ...task.dependsOn])].filter((id) => id !== task.id && byId.has(id));
            const landings = this.store.listLandings(repoId, 0);
            const latestLandings = new Map();
            for (const landing of landings) {
                const latest = latestLandings.get(landing.taskId);
                if (!latest || landing.seq > latest.seq)
                    latestLandings.set(landing.taskId, landing);
            }
            const dependsOn = depIds
                .map((id) => byId.get(id))
                .sort((a, b) => a.rank - b.rank || a.ord - b.ord)
                .map((t) => {
                const landing = latestLandings.get(t.id);
                return { id: t.id, title: t.title, writes: t.writes, status: t.status, ...(landing ? { landedCommit: landing.toMain } : {}) };
            });
            const neighbors = all
                .filter((t) => t.id !== task.id && ACTIVE.has(t.status))
                .map((t) => {
                const latest = this.store
                    .listSubmissions(repoId, t.id)
                    .filter((s) => s.status !== "superseded")
                    .sort((a, b) => b.createdAt - a.createdAt)[0];
                return { id: t.id, title: t.title, writes: t.writes, status: t.status, ...(latest ? { submittedCommit: latest.commit } : {}) };
            });
            // Exemplars: the newest landed task of the same kind, so a worked example reaches every later agent.
            const exemplars = task.kind
                ? landings
                    .filter((l) => l.taskId !== task.id && byId.get(l.taskId)?.kind === task.kind)
                    .sort((a, b) => b.seq - a.seq)
                    .slice(0, 1)
                    .map((l) => ({ taskId: l.taskId, title: byId.get(l.taskId).title, fromMain: l.fromMain, toMain: l.toMain, at: l.at }))
                : [];
            return { repo, task: toTask(task), blockedBy, dependsOn, neighbors, exemplars };
        });
    }
    /** Dynamic scope: replaces the task's scopes and re-runs admission against active tasks. */
    claim(repoId, taskId, input) {
        return this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            const task = this.requireTask(repoId, taskId);
            if (DONE.has(task.status))
                throw new CoordinatorError(409, `task ${taskId} is ${task.status}`);
            const writes = input.writes ?? [];
            const reads = input.reads ?? [];
            const active = this.store
                .listTasks(repoId)
                .filter((t) => t.id !== task.id && ACTIVE.has(t.status) && !(repo.admission === "pipeline" && SUBMITTED.has(t.status)));
            const blockers = (repo.admission === "none" || repo.admission === "declared")
                ? []
                : active
                    .filter((t) => scopesIntersect(t.writes, reads) ||
                    ((repo.admission === "overlaps" || repo.admission === "pipeline") && scopesIntersect(t.writes, writes)))
                    .sort((a, b) => a.rank - b.rank || a.ord - b.ord);
            const blockedBy = blockers.map((t) => t.id);
            const admitted = blockedBy.length === 0;
            const version = this.store.claimCount(repoId, taskId) + 1;
            const at = this.now();
            this.store.insertClaim(repoId, {
                taskId,
                version,
                writes,
                reads,
                baseCommit: task.baseCommit,
                admitted,
                blockedBy,
                createdAt: at,
            });
            const prevStatus = task.status;
            const prevBlockedBy = task.blockedBy;
            task.writes = writes;
            task.reads = reads;
            task.updatedAt = at;
            if (CLAIMABLE.has(task.status)) {
                if (admitted) {
                    task.blockedBy = [];
                    if (task.status === "blocked" || task.status === "planned")
                        task.status = "admitted";
                }
                else {
                    task.blockedBy = blockedBy;
                    task.status = "blocked";
                }
            }
            this.store.updateTask(task);
            this.emit(repoId, "claim", { taskId, payload: { version, writes, reads, admitted, blockedBy } });
            if (task.status !== prevStatus || !sameList(prevBlockedBy, task.blockedBy))
                this.emitAdmission(repoId, task);
            const guidance = admitted
                ? `Scope admitted (claim v${version}). Edit only your declared writes.`
                : `Blocked by ${blockedBy.join(", ")}: wait for them to land (call delta to check) or claim a scope that does not overlap.`;
            return { admitted, blockedBy, version, guidance };
        });
    }
    // ---- submissions -----------------------------------------------------------
    /** Queues a submission. A queued one from the same task is superseded; a leased one rejects with 409. */
    submit(repoId, taskId, input) {
        return this.sql.transaction(() => {
            this.requireRepo(repoId);
            const task = this.requireTask(repoId, taskId);
            if (DONE.has(task.status))
                throw new CoordinatorError(409, `task ${taskId} is already ${task.status}`);
            const existing = this.store.listSubmissions(repoId, taskId);
            const leased = existing.find((s) => s.status === "leased");
            if (leased) {
                throw new CoordinatorError(409, `submission ${leased.id} of task ${taskId} is being integrated; wait for the verdict before resubmitting`);
            }
            const at = this.now();
            const id = this.newId();
            let supersedes;
            for (const queued of existing.filter((s) => s.status === "queued")) {
                queued.status = "superseded";
                queued.updatedAt = at;
                this.store.updateSubmission(repoId, queued);
                supersedes = queued.id;
                this.emit(repoId, "submission.superseded", { taskId, submissionId: queued.id, payload: { by: id } });
            }
            const sub = {
                id,
                taskId,
                commit: input.commit,
                parentMain: input.parentMain,
                summary: input.summary,
                status: "queued",
                createdAt: at,
                updatedAt: at,
            };
            this.store.insertSubmission(repoId, sub);
            if (task.status !== "blocked")
                task.status = "submitted";
            task.updatedAt = at;
            this.store.updateTask(task);
            this.emit(repoId, "submission.queued", {
                taskId,
                submissionId: id,
                payload: { commit: sub.commit, parentMain: sub.parentMain, summary: sub.summary, ...(supersedes ? { supersedes } : {}) },
            });
            if (this.requireRepo(repoId).admission === "pipeline")
                this.readmit(repoId, at);
            return sub;
        });
    }
    getSubmission(repoId, submissionId) {
        this.requireRepo(repoId);
        const sub = this.store.getSubmission(repoId, submissionId);
        if (!sub)
            throw new CoordinatorError(404, `submission ${submissionId} not found`);
        return sub;
    }
    taskStatus(repoId, taskId) {
        this.requireRepo(repoId);
        const task = this.requireTask(repoId, taskId);
        return { task: toTask(task), submissions: this.store.listSubmissions(repoId, taskId) };
    }
    /**
     * Gives up on a task: queued submissions are superseded, the task becomes terminal, and anything it
     * blocked or that waited for it as a producer is released. Rejects with 409 while a submission is leased.
     */
    abandon(repoId, taskId, reason = "") {
        return this.sql.transaction(() => {
            this.requireRepo(repoId);
            const task = this.requireTask(repoId, taskId);
            if (task.status === "abandoned")
                return toTask(task);
            if (task.status === "landed")
                throw new CoordinatorError(409, `task ${taskId} already landed`);
            const existing = this.store.listSubmissions(repoId, taskId);
            const leased = existing.find((s) => s.status === "leased");
            if (leased)
                throw new CoordinatorError(409, `submission ${leased.id} of task ${taskId} is being integrated; wait for the verdict`);
            const at = this.now();
            for (const queued of existing.filter((s) => s.status === "queued")) {
                queued.status = "superseded";
                queued.updatedAt = at;
                this.store.updateSubmission(repoId, queued);
                this.emit(repoId, "submission.superseded", { taskId, submissionId: queued.id, payload: { by: "abandon" } });
            }
            task.status = "abandoned";
            task.blockedBy = [];
            task.updatedAt = at;
            this.store.updateTask(task);
            this.emit(repoId, "task.abandoned", { taskId, payload: { reason } });
            this.readmit(repoId, at);
            return toTask(task);
        });
    }
    // ---- executor --------------------------------------------------------------
    /**
     * Expires stale leases, then leases up to `max` queued submissions in plan order whose task's
     * producers are landed/abandoned or earlier in this same lease.
     *
     * Leases are exclusive per submission, not per repo: any number of integrators may hold batches
     * from the same main at once. Consistency of main is enforced at report time (see `report`).
     */
    /**
     * Lease up to `max` queued submissions in plan order whose producers have landed or are in the batch. With
     * `affinity`, the batch is closed under scope overlap: after the first submission, only submissions whose task
     * scope (writes and reads) touches the batch's are added, and the rest stay queued for another integrator. Several
     * integrators then verify footprint-disjoint batches in parallel, and a push lost to one of them is always a
     * verdict transfer, never a re-verification.
     */
    /**
     * Lease up to `max` queued submissions. With `affinity`, a batch is closed under scope overlap. With `speculate`,
     * a batch that overlaps an in-flight batch whose integrator published its merged candidate is stacked on that
     * candidate instead of main (at most `maxDepth` batches deep, default 3): it is verified on the main it will land
     * on if the batch below lands as merged, instead of on today's main, where it would lose the push race and be
     * verified again. Its integrator reports only once the batch below has landed; anything else makes it stale.
     */
    lease(repoId, executorId, max, opts = {}) {
        return this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            this.expireLeasesInner(repoId);
            if (max <= 0)
                return null;
            const queued = this.store.listSubmissionsByStatus(repoId, "queued");
            if (queued.length === 0)
                return null;
            const tasks = new Map(this.store.listTasks(repoId).map((t) => [t.id, t]));
            const candidates = queued
                .map((s) => ({ s, t: tasks.get(s.taskId) }))
                .filter((c) => c.t !== undefined)
                .sort((a, b) => a.t.rank - b.t.rank || a.s.createdAt - b.s.createdAt || (a.s.id < b.s.id ? -1 : 1));
            const taken = [];
            const takenTasks = new Set();
            const scope = [];
            const now = this.now();
            for (const c of candidates) {
                if (taken.length >= max)
                    break;
                // Deferred by an integrator (BatchResult.defer): not leased, and its scope not held, until the time is up.
                if ((this.deferredUntil.get(`${repoId}\0${c.s.id}`) ?? 0) > now)
                    continue;
                const ready = c.t.producers.every((pid) => {
                    const p = tasks.get(pid);
                    return !p || DONE.has(p.status) || takenTasks.has(pid);
                });
                if (!ready)
                    continue;
                const own = [...c.t.writes, ...c.t.reads];
                // An undeclared scope is unknown, not disjoint: it rides with whatever batch is open.
                if (opts.affinity && taken.length > 0 && own.length > 0 && !scopesIntersect(own, scope))
                    continue;
                taken.push(c);
                takenTasks.add(c.t.id);
                scope.push(...own);
            }
            if (taken.length === 0)
                return null;
            let fromMain = repo.mainCommit;
            let speculativeOn;
            if (opts.speculate && scope.length > 0) {
                const maxDepth = typeof opts.speculate === "object" ? (opts.speculate.maxDepth ?? 3) : 3;
                const base = this.speculationBase(repoId, scope, tasks, maxDepth);
                if (base) {
                    fromMain = base.candidate;
                    speculativeOn = base.batchId;
                }
            }
            const batchId = this.newId();
            const at = this.now();
            const expiresAt = at + this.leaseMs;
            for (const { s, t } of taken) {
                s.status = "leased";
                s.batchId = batchId;
                s.updatedAt = at;
                this.store.updateSubmission(repoId, s);
                if (t.status !== "blocked")
                    t.status = "integrating";
                t.updatedAt = at;
                this.store.updateTask(t);
            }
            const submissionIds = taken.map((c) => c.s.id);
            for (const id of submissionIds)
                this.deferredUntil.delete(`${repoId}\0${id}`);
            this.store.insertLease(repoId, {
                batchId,
                executorId,
                fromMain,
                submissionIds,
                expiresAt,
                createdAt: at,
                status: "active",
                ...(speculativeOn ? { speculativeOn } : {}),
            });
            this.emit(repoId, "lease", { payload: { batchId, executorId, fromMain, submissionIds, expiresAt, ...(speculativeOn ? { speculativeOn } : {}) } });
            const submissions = taken.map((c) => {
                const reverted = this.store
                    .listSubmissions(repoId)
                    .filter((x) => x.taskId === c.s.taskId && x.id !== c.s.id && x.verdict?.reverted)
                    .map((x) => ({ commit: x.commit, prevMain: x.verdict.reverted.prevMain, landed: x.verdict.reverted.landed }));
                return reverted.length > 0 ? { ...c.s, reverted } : c.s;
            });
            return { batchId, executorId, fromMain, submissions, expiresAt, ...(speculativeOn ? { speculativeOn } : {}) };
        });
    }
    /**
     * The tip of the deepest chain of in-flight batches that overlap `scope` and published their candidate, if stacking on
     * it stays within `maxDepth`. The tip, not any overlapping batch: stacking on an older one would put two overlapping
     * batches on one base, and whichever landed second would have to be verified again.
     */
    speculationBase(repoId, scope, tasks, maxDepth) {
        const depthOf = (lease) => {
            let depth = 1;
            let below = lease.speculativeOn ? this.store.getLease(repoId, lease.speculativeOn) : null;
            while (below) {
                depth++;
                below = below.speculativeOn ? this.store.getLease(repoId, below.speculativeOn) : null;
            }
            return depth;
        };
        const overlapping = this.store
            .listActiveLeases(repoId)
            .filter((lease) => {
            if (!lease.candidate)
                return false;
            const theirs = lease.submissionIds.flatMap((id) => {
                const sub = this.store.getSubmission(repoId, id);
                const task = sub ? tasks.get(sub.taskId) : undefined;
                return task ? [...task.writes, ...task.reads] : [];
            });
            return theirs.length > 0 && scopesIntersect(scope, theirs);
        })
            .map((lease) => ({ lease, depth: depthOf(lease) }))
            .sort((a, b) => b.depth - a.depth || b.lease.createdAt - a.lease.createdAt || (a.lease.batchId < b.lease.batchId ? 1 : -1));
        const tip = overlapping[0];
        return tip && tip.depth < maxDepth ? tip.lease : null;
    }
    /** An integrator publishes its batch's merged candidate (pushed to the host as refs/candidates/<batchId>). */
    setCandidate(repoId, batchId, executorId, commit) {
        return this.sql.transaction(() => {
            this.requireRepo(repoId);
            this.expireLeasesInner(repoId);
            const lease = this.store.getLease(repoId, batchId);
            if (!lease)
                throw new CoordinatorError(404, `unknown lease ${batchId}`);
            if (lease.status !== "active")
                throw new CoordinatorError(409, `lease ${batchId} is ${lease.status}`);
            if (lease.executorId !== executorId)
                throw new CoordinatorError(409, `lease ${batchId} is held by ${lease.executorId}`);
            lease.candidate = commit;
            this.store.updateLease(repoId, lease);
            this.emit(repoId, "lease.candidate", { payload: { batchId, executorId, candidate: commit } });
            return { batchId, candidate: commit };
        });
    }
    leaseState(repoId, batchId) {
        return this.sql.transaction(() => {
            this.requireRepo(repoId);
            this.expireLeasesInner(repoId);
            const lease = this.store.getLease(repoId, batchId);
            if (!lease)
                throw new CoordinatorError(404, `unknown lease ${batchId}`);
            return {
                batchId,
                executorId: lease.executorId,
                status: lease.status,
                fromMain: lease.fromMain,
                submissionIds: lease.submissionIds,
                ...(lease.candidate ? { candidate: lease.candidate } : {}),
                ...(lease.speculativeOn ? { speculativeOn: lease.speculativeOn } : {}),
            };
        });
    }
    /**
     * Applies a batch verdict: land, bounce, requeue (anything unmentioned is requeued), move main, re-admit.
     *
     * Several integrators may hold leases on the same main. A lease is stale once main moved past its
     * `fromMain`: a report that lands anything on it is refused with 409 ("stale lease"), every submission
     * of the batch returns to the queue (`submission.requeued`, reason `stale`) so the next lease merges
     * them onto the new main, and the lease is marked `stale` so a late retry is refused too. A report that
     * only bounces or requeues (no landed item, `toMain` equal to `fromMain`) is still applied: verdicts
     * against the old main stay valid for what they reject, and main is left where it is.
     */
    report(repoId, result) {
        const stale = this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            const lease = this.store.getLease(repoId, result.batchId);
            if (!lease)
                throw new CoordinatorError(404, `batch ${result.batchId} not found`);
            if (lease.status === "stale") {
                throw new CoordinatorError(409, `stale lease: batch ${result.batchId} was requeued after main moved from ${lease.fromMain}`);
            }
            if (lease.status !== "active")
                throw new CoordinatorError(409, `batch ${result.batchId} is already ${lease.status}`);
            const at = this.now();
            const mainMoved = lease.fromMain !== repo.mainCommit;
            const lands = result.toMain !== lease.fromMain || result.results.some((r) => r.status === "landed");
            // Verdict transfer: the executor lost the push race, found every landing in between footprint-disjoint from
            // its batch, re-merged onto the current main and reports from there. Accepted only against the current main.
            const rebased = result.rebasedFrom !== undefined && result.rebasedFrom === repo.mainCommit;
            // A stacked batch was verified on a candidate that never became main: none of its verdicts hold, bounces included.
            if (mainMoved && (lands || lease.speculativeOn !== undefined) && !rebased) {
                const requeued = [];
                for (const id of lease.submissionIds) {
                    const sub = this.store.getSubmission(repoId, id);
                    if (sub && sub.status === "leased" && sub.batchId === lease.batchId)
                        requeued.push(sub);
                }
                lease.status = "stale";
                this.store.updateLease(repoId, lease);
                this.emit(repoId, "lease.stale", {
                    payload: {
                        batchId: lease.batchId,
                        executorId: lease.executorId,
                        fromMain: lease.fromMain,
                        mainCommit: repo.mainCommit,
                        submissionIds: requeued.map((s) => s.id),
                    },
                });
                for (const sub of requeued)
                    this.requeueSubmission(repoId, sub, at, { batchId: lease.batchId, reason: "stale" });
                return { fromMain: lease.fromMain, current: repo.mainCommit };
            }
            const inBatch = new Set(lease.submissionIds);
            const handled = new Set();
            const takeLeased = (submissionId) => {
                const sub = this.store.getSubmission(repoId, submissionId);
                if (!sub)
                    throw new CoordinatorError(404, `submission ${submissionId} not found`);
                if (handled.has(submissionId))
                    throw new CoordinatorError(409, `submission ${submissionId} reported twice`);
                if (!inBatch.has(submissionId) || sub.status !== "leased" || sub.batchId !== lease.batchId) {
                    throw new CoordinatorError(409, `submission ${submissionId} is not leased in batch ${lease.batchId}`);
                }
                handled.add(submissionId);
                return sub;
            };
            let fromMain = rebased ? result.rebasedFrom : lease.fromMain;
            for (const item of result.results) {
                const sub = takeLeased(item.submissionId);
                const task = this.requireTask(repoId, sub.taskId);
                sub.verdict = item.verdict;
                sub.updatedAt = at;
                task.updatedAt = at;
                if (item.status === "landed") {
                    const toMain = item.toMain ?? result.toMain;
                    const changed = item.changed ?? [];
                    sub.status = "landed";
                    this.store.updateSubmission(repoId, sub);
                    task.status = "landed";
                    task.blockedBy = [];
                    this.store.updateTask(task);
                    const event = this.emit(repoId, "landing", {
                        taskId: task.id,
                        submissionId: sub.id,
                        payload: { batchId: lease.batchId, fromMain, toMain, changed, verdict: item.verdict, ...(item.verdict.transferred ? { transferred: true } : {}) },
                    });
                    const landing = { seq: event.seq, submissionId: sub.id, taskId: task.id, fromMain, toMain, changed, at, ...(item.footprint ? { footprint: item.footprint } : {}) };
                    this.store.insertLanding(repoId, landing);
                    fromMain = toMain;
                }
                else {
                    sub.status = "bounced";
                    sub.batchId = lease.batchId;
                    this.store.updateSubmission(repoId, sub);
                    task.status = "bounced";
                    this.store.updateTask(task);
                    this.emit(repoId, "bounce", {
                        taskId: task.id,
                        submissionId: sub.id,
                        payload: { batchId: lease.batchId, verdict: item.verdict },
                    });
                }
            }
            const requeue = [...result.requeue];
            for (const id of lease.submissionIds)
                if (!handled.has(id) && !requeue.includes(id))
                    requeue.push(id);
            for (const id of requeue) {
                const sub = takeLeased(id);
                this.requeueSubmission(repoId, sub, at, { batchId: lease.batchId, reason: "report" });
            }
            for (const id of result.defer ?? [])
                if (requeue.includes(id))
                    this.deferredUntil.set(`${repoId}\0${id}`, at + (result.deferMs ?? DEFAULT_DEFER_MS));
            // A bounce-only report on a lease whose main already moved must not rewind main; a report rebased onto the
            // current main (verdict transfer) advances it like any other landing.
            if (!mainMoved || rebased) {
                repo.mainCommit = result.toMain;
                this.store.updateRepo(repo);
            }
            lease.status = "reported";
            this.store.updateLease(repoId, lease);
            this.adjustWindow(repoId, result, repo);
            this.readmit(repoId, at);
            return null;
        });
        // Thrown outside the transaction so the requeue above is committed, not rolled back.
        if (stale)
            throw new CoordinatorError(409, `stale lease: main moved from ${stale.fromMain} to ${stale.current}`);
    }
    /**
     * Settle an optimistic landing once its combined check ran: "verified" marks the verdict; "reverted" bounces the
     * submission with the failing verdict and records the revert commit as a landing on main (by the integrator that
     * pushed it), so agents see main move and the task goes back to its agent.
     */
    settle(repoId, s) {
        this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            const sub = this.store.getSubmission(repoId, s.submissionId);
            if (!sub)
                throw new CoordinatorError(404, `submission ${s.submissionId} not found`);
            if (sub.status !== "landed" || !sub.verdict?.optimistic)
                throw new CoordinatorError(409, `submission ${s.submissionId} is not an optimistic landing`);
            if (sub.verdict.verified || sub.verdict.reverted)
                throw new CoordinatorError(409, `submission ${s.submissionId} is already settled`);
            const at = this.now();
            const task = this.requireTask(repoId, sub.taskId);
            if (s.outcome === "verified") {
                sub.verdict = { ...sub.verdict, verified: true };
                sub.updatedAt = at;
                this.store.updateSubmission(repoId, sub);
                this.emit(repoId, "verified", { taskId: task.id, submissionId: sub.id, payload: { executorId: s.executorId } });
                return;
            }
            const reverted = { commit: s.revert?.commit ?? null, prevMain: s.prevMain, landed: s.landed };
            sub.status = "bounced";
            sub.verdict = { ...s.verdict, optimistic: true, reverted };
            sub.updatedAt = at;
            this.store.updateSubmission(repoId, sub);
            task.status = "bounced";
            task.updatedAt = at;
            this.store.updateTask(task);
            this.emit(repoId, "bounce", { taskId: task.id, submissionId: sub.id, payload: { verdict: sub.verdict, reverted: true } });
            if (s.revert) {
                const event = this.emit(repoId, "landing", {
                    taskId: task.id,
                    submissionId: sub.id,
                    payload: { revert: true, fromMain: s.revert.fromMain, toMain: s.revert.commit, changed: s.revert.changed, executorId: s.executorId },
                });
                this.store.insertLanding(repoId, { seq: event.seq, submissionId: sub.id, taskId: task.id, fromMain: s.revert.fromMain, toMain: s.revert.commit, changed: s.revert.changed, at });
                // The integrator pushed the revert onto the host's main as it was; the coordinator's main follows it.
                repo.mainCommit = s.revert.commit;
                this.store.updateRepo(repo);
            }
            this.readmit(repoId, at);
        });
    }
    /** Extend an active lease held by `executorId`: an integrator renews while a long check runs, so the batch is not handed to another integrator. */
    renewLease(repoId, batchId, executorId) {
        return this.sql.transaction(() => {
            this.requireRepo(repoId);
            this.expireLeasesInner(repoId);
            const lease = this.store.getLease(repoId, batchId);
            if (!lease)
                throw new CoordinatorError(404, `unknown lease ${batchId}`);
            if (lease.status !== "active")
                throw new CoordinatorError(409, `lease ${batchId} is ${lease.status}`);
            if (lease.executorId !== executorId)
                throw new CoordinatorError(409, `lease ${batchId} is held by ${lease.executorId}`);
            lease.expiresAt = this.now() + this.leaseMs;
            this.store.updateLease(repoId, lease);
            return { batchId, expiresAt: lease.expiresAt };
        });
    }
    /** Returns leased submissions of expired leases to the queue. Also runs lazily inside lease(). */
    expireLeases(repoId) {
        return this.sql.transaction(() => {
            this.requireRepo(repoId);
            return this.expireLeasesInner(repoId);
        });
    }
    // ---- reads -----------------------------------------------------------------
    /** Landings after `after` (event seq) that touch the task's paths, bounces of the task after `after`, and admission state. */
    delta(repoId, taskId, after) {
        return this.sql.transaction(() => {
            const repo = this.requireRepo(repoId);
            const task = this.requireTask(repoId, taskId);
            const paths = new Set([...task.reads, ...task.writes].map((s) => s.path));
            const all = this.store.listLandings(repoId, 0);
            // Several submissions can share one landed main. Everything through that commit is already in the fork,
            // even if the host push was observed by the runner before the coordinator recorded its landing.
            const baseSeq = all.reduce((seq, l) => l.toMain === task.baseCommit ? Math.max(seq, l.seq) : seq, 0);
            const landings = all.filter((l) => l.seq > Math.max(after, baseSeq) && l.changed.some((c) => paths.has(c.path)));
            const bounces = this.store
                .bouncedSubmissionIds(repoId, taskId, after)
                .map((id) => this.store.getSubmission(repoId, id))
                .filter((s) => s !== null && s.status === "bounced");
            const admitted = !(task.status === "planned" || task.status === "blocked" || task.status === "abandoned");
            return {
                cursor: this.store.latestSeq(repoId),
                mainCommit: repo.mainCommit,
                landings,
                bounces,
                admitted,
                blockedBy: task.blockedBy,
            };
        });
    }
    events(repoId, after, limit) {
        this.requireRepo(repoId);
        return this.store.listEvents(repoId, Math.max(0, after), Math.max(0, limit));
    }
    /** Landings in order, for executors walking main from their lease's base to the current main. */
    landings(repoId, after = 0) {
        this.requireRepo(repoId);
        return this.store.listLandings(repoId, after);
    }
    /** Share a content-addressed verdict: any integrator or agent whose tree has the same closure reuses it. */
    putVerdict(repoId, input) {
        this.requireRepo(repoId);
        if (!/^closure:[0-9a-f]{64}$/.test(input.key))
            throw new CoordinatorError(400, `verdict key must be closure:<sha256>, got ${input.key}`);
        const record = { key: input.key, checkId: input.checkId, passed: input.passed, failedTests: [...input.failedTests], durationMs: input.durationMs, createdAt: this.now() };
        this.store.putVerdict(repoId, record);
        return record;
    }
    getVerdict(repoId, key, checkId) {
        this.requireRepo(repoId);
        return this.store.getVerdict(repoId, key, checkId);
    }
    /**
     * Optimistic landings that may have left main red: those not yet verified, and those reverted. A main that contains
     * one (and not its revert) may fail checks that are not its changes' fault.
     */
    unsettled(repoId) {
        this.requireRepo(repoId);
        const landedAt = new Map();
        for (const l of this.store.listLandings(repoId, 0))
            if (!landedAt.has(l.submissionId))
                landedAt.set(l.submissionId, l.toMain);
        const out = [];
        for (const s of this.store.listSubmissions(repoId)) {
            const v = s.verdict;
            if (!v?.optimistic)
                continue;
            if (v.reverted)
                out.push({ submissionId: s.id, taskId: s.taskId, landed: v.reverted.landed, revert: v.reverted.commit });
            else if (s.status === "landed" && !v.verified && landedAt.has(s.id))
                out.push({ submissionId: s.id, taskId: s.taskId, landed: landedAt.get(s.id), revert: null });
        }
        return out;
    }
    metrics(repoId) {
        this.requireRepo(repoId);
        const tasks = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
        for (const t of this.store.listTasks(repoId))
            tasks[t.status] = (tasks[t.status] ?? 0) + 1;
        const submissions = Object.fromEntries(SUBMISSION_STATUSES.map((s) => [s, 0]));
        let conflicts = 0;
        let cachedVerdicts = 0;
        let transferredVerdicts = 0;
        let preVerified = 0;
        let unverified = 0;
        let reverted = 0;
        let verdictCount = 0;
        let verdictMs = 0;
        for (const s of this.store.listSubmissions(repoId)) {
            submissions[s.status] = (submissions[s.status] ?? 0) + 1;
            if (s.verdict) {
                if (s.verdict.conflicts.length > 0)
                    conflicts++;
                if (s.verdict.cached)
                    cachedVerdicts++;
                if (s.verdict.transferred)
                    transferredVerdicts++;
                if (s.verdict.preVerified && s.status === "landed")
                    preVerified++;
                if (s.verdict.optimistic && s.status === "landed" && !s.verdict.verified)
                    unverified++;
                if (s.verdict.reverted)
                    reverted++;
            }
            if (s.status === "landed" || s.status === "bounced") {
                verdictCount++;
                verdictMs += s.updatedAt - s.createdAt;
            }
        }
        return {
            tasks,
            submissions,
            landings: this.store.countLandings(repoId),
            bounces: this.store.countEvents(repoId, "bounce"),
            conflicts,
            cachedVerdicts,
            transferredVerdicts,
            preVerified,
            unverified,
            reverted,
            meanSubmitToVerdictMs: verdictCount > 0 ? verdictMs / verdictCount : null,
        };
    }
    // ---- internals -------------------------------------------------------------
    requireRepo(repoId) {
        const repo = this.store.getRepo(repoId);
        if (!repo)
            throw new CoordinatorError(404, `repo ${repoId} not found`);
        return repo;
    }
    requireTask(repoId, taskId) {
        const task = this.store.getTask(repoId, taskId);
        if (!task)
            throw new CoordinatorError(404, `task ${taskId} not found`);
        return task;
    }
    emit(repoId, type, fields) {
        const event = { at: this.now(), type, payload: fields.payload };
        if (fields.taskId !== undefined)
            event.taskId = fields.taskId;
        if (fields.submissionId !== undefined)
            event.submissionId = fields.submissionId;
        return this.store.insertEvent(repoId, event);
    }
    emitAdmission(repoId, task) {
        if (task.status === "blocked") {
            this.emit(repoId, "task.blocked", { taskId: task.id, payload: { rank: task.rank, batch: task.batch, blockedBy: task.blockedBy } });
        }
        else if (task.status === "admitted") {
            this.emit(repoId, "task.admitted", { taskId: task.id, payload: { rank: task.rank, batch: task.batch, blockedBy: [] } });
        }
    }
    requeueSubmission(repoId, sub, at, payload) {
        sub.status = "queued";
        delete sub.batchId;
        sub.updatedAt = at;
        this.store.updateSubmission(repoId, sub);
        const task = this.store.getTask(repoId, sub.taskId);
        if (task && task.status === "integrating") {
            task.status = "submitted";
            task.updatedAt = at;
            this.store.updateTask(task);
        }
        this.emit(repoId, "submission.requeued", { taskId: sub.taskId, submissionId: sub.id, payload });
    }
    expireLeasesInner(repoId) {
        const at = this.now();
        let requeued = 0;
        for (const lease of this.store.listActiveLeases(repoId)) {
            if (lease.expiresAt > at)
                continue;
            const expired = [];
            for (const id of lease.submissionIds) {
                const sub = this.store.getSubmission(repoId, id);
                if (sub && sub.status === "leased" && sub.batchId === lease.batchId)
                    expired.push(sub);
            }
            lease.status = "expired";
            this.store.updateLease(repoId, lease);
            this.emit(repoId, "lease.expired", {
                payload: { batchId: lease.batchId, executorId: lease.executorId, submissionIds: expired.map((s) => s.id) },
            });
            for (const sub of expired)
                this.requeueSubmission(repoId, sub, at, { batchId: lease.batchId, reason: "lease.expired" });
            requeued += expired.length;
        }
        return requeued;
    }
    /** Blocked tasks whose blockers have all landed/been abandoned become admitted; partial progress narrows blockedBy. */
    /** AIMD on the admission window: +1 per clean landing (up to windowMax), halved on a conflict bounce. */
    adjustWindow(repoId, result, repo) {
        if (repo.windowPolicy !== "adaptive")
            return;
        let window = repo.window;
        for (const item of result.results) {
            if (item.status === "bounced" && item.verdict.conflicts.length > 0)
                window = Math.max(1, Math.floor(window / 2));
            else if (item.status === "landed")
                window = Math.min(repo.windowMax, window + 1);
        }
        if (window !== repo.window) {
            repo.window = window;
            this.store.updateRepo(repo);
            this.emit(repoId, "admission.window", { payload: { window, policy: repo.windowPolicy, max: repo.windowMax } });
        }
    }
    readmit(repoId, at) {
        const repo = this.requireRepo(repoId);
        const all = this.store.listTasks(repoId);
        const byId = new Map(all.map((t) => [t.id, t]));
        // In pipeline mode a blocker releases as soon as it has submitted: the blocked task then starts with the
        // blocker's commit in its brief and composes with real code instead of colliding with it at landing.
        const releases = (blocker) => DONE.has(blocker.status) || (repo.admission === "pipeline" && SUBMITTED.has(blocker.status));
        for (const task of all) {
            if (task.status !== "blocked")
                continue;
            const remaining = task.blockedBy.filter((id) => {
                const blocker = byId.get(id);
                return blocker !== undefined && !releases(blocker);
            });
            // The window is how many overlapping writers may be in flight: with window w a task is admitted once
            // fewer than w of its blockers are still unreleased (w = 1 is strict serialization).
            const admitNow = remaining.length < Math.max(1, repo.window);
            if (remaining.length === task.blockedBy.length && !admitNow)
                continue;
            task.blockedBy = remaining;
            task.updatedAt = at;
            if (admitNow)
                task.status = "admitted";
            this.store.updateTask(task);
            this.emitAdmission(repoId, task);
        }
    }
}
//# sourceMappingURL=coordinator.js.map