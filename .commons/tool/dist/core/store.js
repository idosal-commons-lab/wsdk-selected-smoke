const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    main_commit TEXT NOT NULL,
    test_command TEXT NOT NULL,
    related_test_command TEXT,
    privacy TEXT NOT NULL,
    admission TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    window INTEGER NOT NULL DEFAULT 1,
    window_policy TEXT NOT NULL DEFAULT 'fixed',
    window_max INTEGER NOT NULL DEFAULT 4
  )`,
    `CREATE TABLE IF NOT EXISTS tasks (
    repo_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT,
    status TEXT NOT NULL,
    writes TEXT NOT NULL,
    reads TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    producers TEXT NOT NULL,
    task_rank INTEGER NOT NULL,
    batch INTEGER NOT NULL,
    blocked_by TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    agent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, id)
  )`,
    `CREATE TABLE IF NOT EXISTS claims (
    repo_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    writes TEXT NOT NULL,
    reads TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    admitted INTEGER NOT NULL,
    blocked_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, task_id, version)
  )`,
    `CREATE TABLE IF NOT EXISTS submissions (
    repo_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    parent_main TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    batch_id TEXT,
    verdict TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, id)
  )`,
    `CREATE INDEX IF NOT EXISTS submissions_repo_task ON submissions(repo_id, task_id)`,
    `CREATE INDEX IF NOT EXISTS submissions_repo_status ON submissions(repo_id, status)`,
    `CREATE TABLE IF NOT EXISTS landings (
    repo_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    submission_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    from_main TEXT NOT NULL,
    to_main TEXT NOT NULL,
    changed TEXT NOT NULL,
    at INTEGER NOT NULL,
    footprint TEXT,
    PRIMARY KEY (repo_id, seq)
  )`,
    `CREATE TABLE IF NOT EXISTS events (
    repo_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    task_id TEXT,
    submission_id TEXT,
    payload TEXT NOT NULL,
    PRIMARY KEY (repo_id, seq)
  )`,
    `CREATE INDEX IF NOT EXISTS events_repo_seq ON events(repo_id, seq)`,
    `CREATE INDEX IF NOT EXISTS events_repo_task_type ON events(repo_id, task_id, type, seq)`,
    `CREATE TABLE IF NOT EXISTS leases (
    repo_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    executor_id TEXT NOT NULL,
    from_main TEXT NOT NULL,
    submission_ids TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    candidate TEXT,
    speculative_on TEXT,
    PRIMARY KEY (repo_id, batch_id)
  )`,
    `CREATE TABLE IF NOT EXISTS verdicts (
    repo_id TEXT NOT NULL,
    key TEXT NOT NULL,
    check_id TEXT NOT NULL,
    passed INTEGER NOT NULL,
    failed_tests TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (repo_id, key, check_id)
  )`,
];
const enc = (value) => JSON.stringify(value);
const dec = (value, fallback) => {
    if (typeof value !== "string" || value === "")
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
};
const str = (v) => (v === null ? "" : String(v));
const num = (v) => (v === null ? 0 : Number(v));
const opt = (v) => (v === undefined || v === null ? null : v);
export function toTask(row) {
    const task = {
        id: row.id,
        repoId: row.repoId,
        title: row.title,
        body: row.body,
        status: row.status,
        writes: row.writes,
        reads: row.reads,
        dependsOn: row.dependsOn,
        rank: row.rank,
        batch: row.batch,
        blockedBy: row.blockedBy,
        baseCommit: row.baseCommit,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
    if (row.kind !== undefined)
        task.kind = row.kind;
    if (row.agentId !== undefined)
        task.agentId = row.agentId;
    return task;
}
function rowToRepo(r) {
    const repo = {
        id: str(r.id),
        name: str(r.name),
        mainCommit: str(r.main_commit),
        testCommand: str(r.test_command),
        privacy: str(r.privacy),
        admission: str(r.admission),
        window: r.window === null || r.window === undefined ? 1 : num(r.window),
        windowPolicy: (r.window_policy === null || r.window_policy === undefined ? "fixed" : str(r.window_policy)),
        windowMax: r.window_max === null || r.window_max === undefined ? 4 : num(r.window_max),
        createdAt: num(r.created_at),
    };
    if (r.related_test_command !== null && r.related_test_command !== undefined) {
        repo.relatedTestCommand = str(r.related_test_command);
    }
    return repo;
}
function rowToTask(r) {
    const task = {
        id: str(r.id),
        repoId: str(r.repo_id),
        title: str(r.title),
        body: str(r.body),
        status: str(r.status),
        writes: dec(r.writes, []),
        reads: dec(r.reads, []),
        dependsOn: dec(r.depends_on, []),
        rank: num(r.task_rank),
        batch: num(r.batch),
        blockedBy: dec(r.blocked_by, []),
        baseCommit: str(r.base_commit),
        createdAt: num(r.created_at),
        updatedAt: num(r.updated_at),
        ord: num(r.ord),
        producers: dec(r.producers, []),
    };
    if (r.agent_id !== null && r.agent_id !== undefined)
        task.agentId = str(r.agent_id);
    if (r.kind !== null && r.kind !== undefined)
        task.kind = str(r.kind);
    return task;
}
function rowToSubmission(r) {
    const sub = {
        id: str(r.id),
        taskId: str(r.task_id),
        commit: str(r.commit_sha),
        parentMain: str(r.parent_main),
        summary: str(r.summary),
        status: str(r.status),
        createdAt: num(r.created_at),
        updatedAt: num(r.updated_at),
    };
    if (r.batch_id !== null && r.batch_id !== undefined)
        sub.batchId = str(r.batch_id);
    const verdict = dec(r.verdict, null);
    if (verdict)
        sub.verdict = verdict;
    return sub;
}
function rowToLanding(r) {
    const landing = {
        seq: num(r.seq),
        submissionId: str(r.submission_id),
        taskId: str(r.task_id),
        fromMain: str(r.from_main),
        toMain: str(r.to_main),
        changed: dec(r.changed, []),
        at: num(r.at),
    };
    if (r.footprint !== null && r.footprint !== undefined)
        landing.footprint = dec(r.footprint, { changed: [], closure: null });
    return landing;
}
function rowToEvent(r) {
    const event = {
        seq: num(r.seq),
        at: num(r.at),
        type: str(r.type),
        payload: dec(r.payload, null),
    };
    if (r.task_id !== null && r.task_id !== undefined)
        event.taskId = str(r.task_id);
    if (r.submission_id !== null && r.submission_id !== undefined)
        event.submissionId = str(r.submission_id);
    return event;
}
function rowToLease(r) {
    return {
        batchId: str(r.batch_id),
        executorId: str(r.executor_id),
        fromMain: str(r.from_main),
        submissionIds: dec(r.submission_ids, []),
        expiresAt: num(r.expires_at),
        createdAt: num(r.created_at),
        status: str(r.status),
        ...(r.candidate !== null && r.candidate !== undefined ? { candidate: str(r.candidate) } : {}),
        ...(r.speculative_on !== null && r.speculative_on !== undefined ? { speculativeOn: str(r.speculative_on) } : {}),
    };
}
function rowToClaim(r) {
    return {
        taskId: str(r.task_id),
        version: num(r.version),
        writes: dec(r.writes, []),
        reads: dec(r.reads, []),
        baseCommit: str(r.base_commit),
        admitted: num(r.admitted) === 1,
        blockedBy: dec(r.blocked_by, []),
        createdAt: num(r.created_at),
    };
}
export class Store {
    sql;
    constructor(sql) {
        this.sql = sql;
    }
    /** Idempotent: every statement is CREATE ... IF NOT EXISTS. */
    migrate() {
        for (const stmt of SCHEMA)
            this.sql.exec(stmt);
        // Columns added after the first release; ALTER fails harmlessly when they already exist.
        for (const alter of [
            "ALTER TABLE repos ADD COLUMN window INTEGER NOT NULL DEFAULT 1",
            "ALTER TABLE repos ADD COLUMN window_policy TEXT NOT NULL DEFAULT 'fixed'",
            "ALTER TABLE repos ADD COLUMN window_max INTEGER NOT NULL DEFAULT 4",
            "ALTER TABLE tasks ADD COLUMN kind TEXT",
            "ALTER TABLE landings ADD COLUMN footprint TEXT",
            "ALTER TABLE leases ADD COLUMN candidate TEXT",
            "ALTER TABLE leases ADD COLUMN speculative_on TEXT",
        ]) {
            try {
                this.sql.exec(alter);
            }
            catch {
                /* already present */
            }
        }
    }
    // ---- events ----------------------------------------------------------------
    nextSeq(repoId) {
        const [row] = this.sql.exec("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE repo_id = ?", repoId);
        return row ? num(row.n) : 1;
    }
    latestSeq(repoId) {
        const [row] = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS n FROM events WHERE repo_id = ?", repoId);
        return row ? num(row.n) : 0;
    }
    insertEvent(repoId, event) {
        const seq = this.nextSeq(repoId);
        this.sql.exec("INSERT INTO events (repo_id, seq, at, type, task_id, submission_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)", repoId, seq, event.at, event.type, opt(event.taskId), opt(event.submissionId), enc(event.payload ?? null));
        const stored = { seq, at: event.at, type: event.type, payload: event.payload ?? null };
        if (event.taskId !== undefined)
            stored.taskId = event.taskId;
        if (event.submissionId !== undefined)
            stored.submissionId = event.submissionId;
        return stored;
    }
    listEvents(repoId, after, limit) {
        return this.sql
            .exec("SELECT * FROM events WHERE repo_id = ? AND seq > ? ORDER BY seq LIMIT ?", repoId, after, limit)
            .map(rowToEvent);
    }
    countEvents(repoId, type) {
        const [row] = this.sql.exec("SELECT COUNT(*) AS n FROM events WHERE repo_id = ? AND type = ?", repoId, type);
        return row ? num(row.n) : 0;
    }
    /** Submission ids named by `bounce` events for a task after a cursor, oldest first, deduplicated. */
    bouncedSubmissionIds(repoId, taskId, after) {
        const rows = this.sql.exec("SELECT submission_id FROM events WHERE repo_id = ? AND task_id = ? AND type = 'bounce' AND seq > ? ORDER BY seq", repoId, taskId, after);
        const out = [];
        for (const r of rows) {
            const id = str(r.submission_id);
            if (id && !out.includes(id))
                out.push(id);
        }
        return out;
    }
    // ---- repos -----------------------------------------------------------------
    insertRepo(repo) {
        this.sql.exec("INSERT INTO repos (id, name, main_commit, test_command, related_test_command, privacy, admission, created_at, window, window_policy, window_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", repo.id, repo.name, repo.mainCommit, repo.testCommand, opt(repo.relatedTestCommand), repo.privacy, repo.admission, repo.createdAt, repo.window, repo.windowPolicy, repo.windowMax);
    }
    getRepo(id) {
        const [row] = this.sql.exec("SELECT * FROM repos WHERE id = ?", id);
        return row ? rowToRepo(row) : null;
    }
    updateRepo(repo) {
        this.sql.exec("UPDATE repos SET name = ?, main_commit = ?, test_command = ?, related_test_command = ?, privacy = ?, admission = ?, window = ?, window_policy = ?, window_max = ? WHERE id = ?", repo.name, repo.mainCommit, repo.testCommand, opt(repo.relatedTestCommand), repo.privacy, repo.admission, repo.window, repo.windowPolicy, repo.windowMax, repo.id);
    }
    // ---- tasks -----------------------------------------------------------------
    insertTask(task) {
        this.sql.exec(`INSERT INTO tasks (repo_id, id, ord, title, body, status, writes, reads, depends_on, producers, task_rank, batch, blocked_by, base_commit, agent_id, created_at, updated_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, task.repoId, task.id, task.ord, task.title, task.body, task.status, enc(task.writes), enc(task.reads), enc(task.dependsOn), enc(task.producers), task.rank, task.batch, enc(task.blockedBy), task.baseCommit, opt(task.agentId), task.createdAt, task.updatedAt, opt(task.kind));
    }
    updateTask(task) {
        this.sql.exec(`UPDATE tasks SET title = ?, body = ?, status = ?, writes = ?, reads = ?, depends_on = ?, producers = ?, task_rank = ?, batch = ?, blocked_by = ?, base_commit = ?, agent_id = ?, updated_at = ?, kind = ?
       WHERE repo_id = ? AND id = ?`, task.title, task.body, task.status, enc(task.writes), enc(task.reads), enc(task.dependsOn), enc(task.producers), task.rank, task.batch, enc(task.blockedBy), task.baseCommit, opt(task.agentId), task.updatedAt, opt(task.kind), task.repoId, task.id);
    }
    getTask(repoId, id) {
        const [row] = this.sql.exec("SELECT * FROM tasks WHERE repo_id = ? AND id = ?", repoId, id);
        return row ? rowToTask(row) : null;
    }
    listTasks(repoId) {
        return this.sql.exec("SELECT * FROM tasks WHERE repo_id = ? ORDER BY ord", repoId).map(rowToTask);
    }
    nextOrd(repoId) {
        const [row] = this.sql.exec("SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM tasks WHERE repo_id = ?", repoId);
        return row ? num(row.n) : 0;
    }
    // ---- claims ----------------------------------------------------------------
    insertClaim(repoId, claim) {
        this.sql.exec("INSERT INTO claims (repo_id, task_id, version, writes, reads, base_commit, admitted, blocked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", repoId, claim.taskId, claim.version, enc(claim.writes), enc(claim.reads), claim.baseCommit, claim.admitted ? 1 : 0, enc(claim.blockedBy), claim.createdAt);
    }
    listClaims(repoId, taskId) {
        return this.sql
            .exec("SELECT * FROM claims WHERE repo_id = ? AND task_id = ? ORDER BY version", repoId, taskId)
            .map(rowToClaim);
    }
    claimCount(repoId, taskId) {
        const [row] = this.sql.exec("SELECT COUNT(*) AS n FROM claims WHERE repo_id = ? AND task_id = ?", repoId, taskId);
        return row ? num(row.n) : 0;
    }
    // ---- submissions -----------------------------------------------------------
    insertSubmission(repoId, sub) {
        this.sql.exec("INSERT INTO submissions (repo_id, id, task_id, commit_sha, parent_main, summary, status, batch_id, verdict, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", repoId, sub.id, sub.taskId, sub.commit, sub.parentMain, sub.summary, sub.status, opt(sub.batchId), sub.verdict ? enc(sub.verdict) : null, sub.createdAt, sub.updatedAt);
    }
    updateSubmission(repoId, sub) {
        this.sql.exec("UPDATE submissions SET summary = ?, status = ?, batch_id = ?, verdict = ?, updated_at = ? WHERE repo_id = ? AND id = ?", sub.summary, sub.status, opt(sub.batchId), sub.verdict ? enc(sub.verdict) : null, sub.updatedAt, repoId, sub.id);
    }
    getSubmission(repoId, id) {
        const [row] = this.sql.exec("SELECT * FROM submissions WHERE repo_id = ? AND id = ?", repoId, id);
        return row ? rowToSubmission(row) : null;
    }
    listSubmissions(repoId, taskId) {
        const rows = taskId === undefined
            ? this.sql.exec("SELECT * FROM submissions WHERE repo_id = ? ORDER BY created_at, id", repoId)
            : this.sql.exec("SELECT * FROM submissions WHERE repo_id = ? AND task_id = ? ORDER BY created_at, id", repoId, taskId);
        return rows.map(rowToSubmission);
    }
    listSubmissionsByStatus(repoId, status) {
        return this.sql
            .exec("SELECT * FROM submissions WHERE repo_id = ? AND status = ? ORDER BY created_at, id", repoId, status)
            .map(rowToSubmission);
    }
    // ---- landings --------------------------------------------------------------
    insertLanding(repoId, landing) {
        this.sql.exec("INSERT INTO landings (repo_id, seq, submission_id, task_id, from_main, to_main, changed, at, footprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", repoId, landing.seq, landing.submissionId, landing.taskId, landing.fromMain, landing.toMain, enc(landing.changed), landing.at, landing.footprint ? enc(landing.footprint) : null);
    }
    listLandings(repoId, after) {
        return this.sql
            .exec("SELECT * FROM landings WHERE repo_id = ? AND seq > ? ORDER BY seq", repoId, after)
            .map(rowToLanding);
    }
    countLandings(repoId) {
        const [row] = this.sql.exec("SELECT COUNT(*) AS n FROM landings WHERE repo_id = ?", repoId);
        return row ? num(row.n) : 0;
    }
    // ---- verdicts (content-addressed, shared) -----------------------------------
    putVerdict(repoId, v) {
        this.sql.exec("INSERT OR REPLACE INTO verdicts (repo_id, key, check_id, passed, failed_tests, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", repoId, v.key, v.checkId, v.passed ? 1 : 0, enc(v.failedTests), v.durationMs, v.createdAt);
    }
    getVerdict(repoId, key, checkId) {
        const [row] = this.sql.exec("SELECT * FROM verdicts WHERE repo_id = ? AND key = ? AND check_id = ?", repoId, key, checkId);
        if (!row)
            return null;
        return {
            key: str(row.key),
            checkId: str(row.check_id),
            passed: num(row.passed) === 1,
            failedTests: dec(row.failed_tests, []),
            durationMs: num(row.duration_ms),
            createdAt: num(row.created_at),
        };
    }
    // ---- leases ----------------------------------------------------------------
    insertLease(repoId, lease) {
        this.sql.exec("INSERT INTO leases (repo_id, batch_id, executor_id, from_main, submission_ids, expires_at, created_at, status, candidate, speculative_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", repoId, lease.batchId, lease.executorId, lease.fromMain, enc(lease.submissionIds), lease.expiresAt, lease.createdAt, lease.status, lease.candidate ?? null, lease.speculativeOn ?? null);
    }
    updateLease(repoId, lease) {
        this.sql.exec("UPDATE leases SET executor_id = ?, from_main = ?, submission_ids = ?, expires_at = ?, status = ?, candidate = ?, speculative_on = ? WHERE repo_id = ? AND batch_id = ?", lease.executorId, lease.fromMain, enc(lease.submissionIds), lease.expiresAt, lease.status, lease.candidate ?? null, lease.speculativeOn ?? null, repoId, lease.batchId);
    }
    getLease(repoId, batchId) {
        const [row] = this.sql.exec("SELECT * FROM leases WHERE repo_id = ? AND batch_id = ?", repoId, batchId);
        return row ? rowToLease(row) : null;
    }
    listActiveLeases(repoId) {
        return this.sql
            .exec("SELECT * FROM leases WHERE repo_id = ? AND status = 'active' ORDER BY created_at, batch_id", repoId)
            .map(rowToLease);
    }
}
//# sourceMappingURL=store.js.map