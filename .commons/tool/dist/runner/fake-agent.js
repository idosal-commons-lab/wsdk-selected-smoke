// A deterministic stand-in for a model so the whole pipeline (worktrees, coordinator, executor, host, report)
// can be exercised without tokens. It mirrors what the MCP server does for a real agent, talking to the
// coordinator HTTP API directly in the full arm and using the MCP tool runner in the queue arm.
//
// Task bodies carry instructions:
//   FAKE: write <path> <content>   write <content> (plus a newline) to <path>
//   FAKE: fail-if <path>           give up ("NOT LANDED") when <path> exists at integration time
//   FAKE: fix-on-resume <path> <content>   when resumed after a bounce (COMMONS_RESUME=1), write <content> to <path>
//   FAKE: usage-limit              exit at once the way an agent whose account is out of usage does
//   FAKE: candidate <i> write <path> <content>   best-of-N candidate i (COMMONS_CANDIDATE_FILE ends in .<i>.json) also writes this
//   FAKE: replay <trace.json>      replay this task's recorded submissions (src/bench/replay/trace.ts); commons/queue arms
// Candidate mode (COMMONS_CANDIDATE_FILE): commit, record the commit in that file instead of submitting, exit.
//
// Detached mode (COMMONS_DETACH=1): submit without waiting and exit with "SUBMITTED <sha>"; when resumed
// (COMMONS_RESUME=1, the verdict in COMMONS_RESUME_PROMPT) rebase, apply the fix-on-resume writes, resubmit, exit.
//
// Environment (set by the runner): COMMONS_ARM (commons|queue|baseline), COMMONS_TASK, COMMONS_HOST (git remote of the
// host), and for the commons/queue arms COMMONS_URL + COMMONS_REPO; for queue/baseline COMMONS_TASK_BODY (or
// COMMONS_PROMPT_PATH) and optionally COMMONS_NOTES_DIR. The cwd is the task worktree.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CoordinatorClient } from "../adapter/client.js";
import { createToolRunner } from "../adapter/mcp.js";
import { git, gitRaw } from "../executor/git.js";
import { hostFor } from "../executor/host.js";
import { taskRefFor } from "../executor/task-ref.js";
export function parseInstructions(text) {
    const out = { writes: [], failIf: [], fixes: [] };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        const write = /^FAKE:\s*write\s+(\S+)\s+(.*)$/.exec(line);
        if (write) {
            out.writes.push({ path: write[1], content: write[2] });
            continue;
        }
        const fix = /^FAKE:\s*fix-on-resume\s+(\S+)\s+(.*)$/.exec(line);
        if (fix) {
            out.fixes.push({ path: fix[1], content: fix[2] });
            continue;
        }
        const failIf = /^FAKE:\s*fail-if\s+(\S+)\s*$/.exec(line);
        if (failIf)
            out.failIf.push(failIf[1]);
    }
    return out;
}
const COMMONS_SUBMITS = 2; // first submission plus one resubmit after a bounce
const BASELINE_PUSHES = 3;
const REPLAY_RETRIES = 1; // replays of the last recorded change after it bounces where the recorded run landed it
const REPLAY_VERDICT_TIMEOUT_MS = 60 * 60 * 1000; // real checks: a verdict can be many minutes away
const VERDICT_TIMEOUT_MS = 5 * 60 * 1000;
const VERDICT_POLL_MS = 250;
const firstLine = (s) => s.trim().split(/\r?\n/)[0] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Agent {
    cwd;
    taskId;
    hostUrl;
    identity;
    constructor(cwd, taskId, hostUrl) {
        this.cwd = cwd;
        this.taskId = taskId;
        this.hostUrl = hostUrl;
        const name = `Commons Agent ${taskId}`;
        const email = `${taskId}@commons.invalid`;
        this.identity = { ...hostFor(hostUrl).gitEnv, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    }
    taskRef() {
        return process.env.COMMONS_TASK_REF_PREFIX ? taskRefFor(process.env.COMMONS_TASK_REF_PREFIX, this.taskId) : hostFor(this.hostUrl).taskRef(this.taskId);
    }
    git(args) {
        return git(this.cwd, args, { env: this.identity });
    }
    gitRaw(args) {
        return gitRaw(this.cwd, args, { env: this.identity });
    }
    /** Apply the writes and commit them (when anything changed). */
    async applyWrites(instr) {
        await this.write(instr.writes, `${this.taskId}: fake change (${instr.writes.map((w) => w.path).join(", ") || "no files"})`);
    }
    async write(writes, message) {
        for (const w of writes) {
            const full = resolve(this.cwd, w.path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, `${w.content}\n`);
        }
        await this.commitIfDirty(message);
    }
    async commitIfDirty(message) {
        await this.git(["add", "-A"]);
        const status = await this.git(["status", "--porcelain"]);
        if (!status)
            return false;
        await this.git(["commit", "--quiet", "-m", message]);
        return true;
    }
    failIfHit(instr) {
        return instr.failIf.find((p) => existsSync(resolve(this.cwd, p)));
    }
    /** `git fetch origin main && git rebase origin/main`; returns an error message on conflict (after aborting). */
    async rebaseOnMain() {
        const branch = process.env.COMMONS_MAIN_BRANCH ?? "main";
        await this.git(["fetch", "--quiet", "origin", branch]);
        const r = await this.gitRaw(["rebase", `origin/${branch}`]);
        if (r.code === 0)
            return undefined;
        await this.gitRaw(["rebase", "--abort"]);
        const detail = r.stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? r.stdout.trim();
        return `rebase onto origin/${branch} failed: ${detail}`;
    }
}
function finish(line) {
    console.log(line);
    process.exit(0);
}
function required(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`${name} is not set`);
    return value;
}
async function waitForVerdict(client, repoId, submissionId) {
    const deadline = Date.now() + VERDICT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const sub = await client.submission(repoId, submissionId);
        if (sub.status === "landed" || sub.status === "bounced" || sub.status === "superseded")
            return sub;
        await sleep(VERDICT_POLL_MS);
    }
    throw new Error(`timed out waiting for the verdict of submission ${submissionId}`);
}
const detached = () => process.env.COMMONS_DETACH === "1";
const resumed = () => process.env.COMMONS_RESUME === "1";
/** Best-of-N candidate: the shared writes plus this candidate's own, committed and recorded for the runner. */
async function candidateCommons(agent, instr, body, file) {
    const index = /\.(\d+)\.json$/.exec(file)?.[1] ?? "0";
    await agent.applyWrites(instr);
    const own = [...body.matchAll(/^FAKE:\s*candidate\s+(\d+)\s+write\s+(\S+)\s+(.*)$/gm)].filter((m) => m[1] === index).map((m) => ({ path: m[2], content: m[3] }));
    if (own.length > 0)
        await agent.write(own, `${agent.taskId}: candidate ${index}`);
    const sha = await agent.git(["rev-parse", "HEAD"]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ commit: sha, summary: `${agent.taskId}: candidate ${index}` }) + "\n");
    finish(`SUBMITTED ${sha}`);
}
/** Detached: one submission (the initial commit, or the rebased and fixed one when resumed), then exit. */
async function detachedCommons(agent, client, repoId, instr, title) {
    if (resumed()) {
        const error = await agent.rebaseOnMain();
        if (error)
            finish(`NOT LANDED: ${error}`);
        await agent.write(instr.fixes, `${agent.taskId}: fix after bounce`);
    }
    else
        await agent.applyWrites(instr);
    const hit = agent.failIfHit(instr);
    if (hit)
        finish(`NOT LANDED: ${hit} exists in the worktree`);
    const sha = await agent.git(["rev-parse", "HEAD"]);
    await agent.git(["push", "--quiet", "--force", agent.hostUrl, `HEAD:${agent.taskRef()}`]);
    const parentMain = (await client.getRepo(repoId)).mainCommit;
    await client.submit(repoId, agent.taskId, { commit: sha, parentMain, summary: `${agent.taskId}: ${title}` });
    finish(`SUBMITTED ${sha}`);
}
async function commonsArm(agent) {
    const client = new CoordinatorClient(required("COMMONS_URL"), process.env.COMMONS_TOKEN);
    const repoId = required("COMMONS_REPO");
    const meta = await client.briefMeta(repoId, agent.taskId);
    const instr = parseInstructions(meta.task.body);
    if (process.env.COMMONS_CANDIDATE_FILE && !resumed())
        return candidateCommons(agent, instr, meta.task.body, process.env.COMMONS_CANDIDATE_FILE);
    if (detached())
        return detachedCommons(agent, client, repoId, instr, meta.task.title);
    await agent.applyWrites(instr);
    let parentMain = meta.repo.mainCommit;
    let lastVerdict = "";
    for (let attempt = 1; attempt <= COMMONS_SUBMITS; attempt++) {
        const hit = agent.failIfHit(instr);
        if (hit)
            finish(`NOT LANDED: ${hit} exists in the worktree`);
        const sha = await agent.git(["rev-parse", "HEAD"]);
        await agent.git(["push", "--quiet", "--force", agent.hostUrl, `HEAD:${agent.taskRef()}`]);
        const sub = await client.submit(repoId, agent.taskId, { commit: sha, parentMain, summary: `${agent.taskId}: ${meta.task.title}` });
        const verdict = await waitForVerdict(client, repoId, sub.id);
        if (verdict.status === "landed")
            finish(`LANDED ${sha}`);
        lastVerdict = verdict.verdict?.excerpt ?? verdict.status;
        if (attempt < COMMONS_SUBMITS) {
            const error = await agent.rebaseOnMain();
            if (error)
                finish(`NOT LANDED: ${error}`);
            await agent.commitIfDirty(`${agent.taskId}: after rebase`);
            parentMain = (await client.getRepo(repoId)).mainCommit;
        }
    }
    finish(`NOT LANDED: bounced ${COMMONS_SUBMITS} times (${firstLine(lastVerdict)})`);
}
/**
 * Replay a recorded task: each recorded submission's change, after the time the agent took before it (scaled by
 * COMMONS_REPLAY_SCALE), applied three-way to the agent's fork for the first and to the current main for later ones,
 * then submitted through the same submit tool (and pre-verification) a model's MCP server uses. A recorded change that
 * now bounces is tried again on the moved main, as an agent would, before the replay gives up.
 */
async function replayArm(agent, tracePath) {
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    const task = trace.tasks[agent.taskId];
    if (!task)
        finish(`NOT LANDED: ${agent.taskId} is not in the trace`);
    const scale = Number(process.env.COMMONS_REPLAY_SCALE ?? "1");
    const env = process.env;
    const client = new CoordinatorClient(required("COMMONS_URL"), env.COMMONS_TOKEN);
    const repoId = required("COMMONS_REPO");
    const branch = env.COMMONS_MAIN_BRANCH ?? "main";
    const runner = createToolRunner({
        client,
        repoId,
        taskId: agent.taskId,
        worktree: agent.cwd,
        remote: agent.hostUrl,
        gitEnv: hostFor(agent.hostUrl).gitEnv,
        taskRefPrefix: agent.taskRef().slice(0, -agent.taskId.length),
        mainBranch: env.COMMONS_MAIN_BRANCH,
        tools: ["submit"],
        pollMs: VERDICT_POLL_MS,
        ...(env.COMMONS_PREVERIFY === "1" && env.COMMONS_TEST_COMMAND
            ? {
                preverify: {
                    test: env.COMMONS_TEST_COMMAND,
                    ...(env.COMMONS_RELATED_COMMAND ? { related: env.COMMONS_RELATED_COMMAND } : {}),
                    ...(env.COMMONS_CHECK_CACHE ? { cachePath: env.COMMONS_CHECK_CACHE } : {}),
                    ...(env.COMMONS_PREVERIFY_TIMEOUT_MS ? { timeoutMs: Number(env.COMMONS_PREVERIFY_TIMEOUT_MS) } : {}),
                },
            }
            : {}),
        ...(detached() ? { detach: true } : {}),
    });
    await useTraceObjects(agent.cwd, trace.objects);
    const recorded = task.attempts.length;
    let attempt = (await client.taskStatus(repoId, agent.taskId)).submissions.length;
    let lastVerdict = "never submitted in the recorded run";
    for (; recorded > 0 && attempt < recorded + REPLAY_RETRIES; attempt++) {
        const a = task.attempts[Math.min(attempt, recorded - 1)];
        if (attempt < recorded)
            await sleep(a.thinkMs * scale);
        if (attempt > 0 || resumed()) {
            await agent.git(["fetch", "--quiet", "origin", branch]);
            await agent.git(["reset", "--quiet", "--hard", `origin/${branch}`]);
        }
        const applied = await agent.gitRaw(["apply", "--3way", "--whitespace=nowarn", resolve(dirname(tracePath), a.patch)]);
        if (applied.code !== 0)
            finish(`NOT LANDED: the recorded change does not apply to ${attempt > 0 || resumed() ? "main" : "the fork"}: ${firstLine(applied.stderr)}`);
        if (!(await agent.commitIfDirty(`${agent.taskId}: replayed submission ${attempt + 1}`)))
            finish("NOT LANDED: the recorded change is already on main");
        const sha = await agent.git(["rev-parse", "HEAD"]);
        const result = await runner.call("submit", { summary: `${agent.taskId}: replayed submission ${attempt + 1}`, wait: !detached(), timeoutMs: REPLAY_VERDICT_TIMEOUT_MS });
        lastVerdict = result.content.map((c) => c.text).join("\n");
        if (detached() && !result.isError)
            finish(`SUBMITTED ${sha}`);
        if (lastVerdict.includes("Verdict: landed"))
            finish(`LANDED ${sha}`);
    }
    await sleep((task.giveUpMs ?? 0) * scale);
    finish(`NOT LANDED: ${firstLine(lastVerdict)}`);
}
/**
 * Make the trace's objects part of the worktree's object store (an alternate), for every later command: a three-way
 * apply records a new file by the blob id the patch names, which exists only there, and the commit, the push to the
 * host and a pre-verification snapshot of the worktree all need to read it.
 */
export async function useTraceObjects(worktree, objects) {
    const common = resolve(worktree, await git(worktree, ["rev-parse", "--git-common-dir"]));
    const file = resolve(common, "objects", "info", "alternates");
    const known = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
    if (known.includes(objects))
        return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, [...known.filter(Boolean), objects].join("\n") + "\n");
}
function taskBody() {
    const body = process.env.COMMONS_TASK_BODY;
    if (body)
        return body;
    const promptPath = process.env.COMMONS_PROMPT_PATH;
    if (promptPath && existsSync(promptPath))
        return readFileSync(promptPath, "utf8");
    return "";
}
async function queueArm(agent) {
    const instr = parseInstructions(taskBody());
    if (detached() && resumed()) {
        const error = await agent.rebaseOnMain();
        if (error)
            finish(`NOT LANDED: ${error}`);
        await agent.write(instr.fixes, `${agent.taskId}: fix after bounce`);
    }
    else
        await agent.applyWrites(instr);
    const runner = createToolRunner({
        client: new CoordinatorClient(required("COMMONS_URL"), process.env.COMMONS_TOKEN),
        repoId: required("COMMONS_REPO"),
        taskId: agent.taskId,
        worktree: agent.cwd,
        remote: agent.hostUrl,
        gitEnv: hostFor(agent.hostUrl).gitEnv,
        taskRefPrefix: agent.taskRef().slice(0, -agent.taskId.length),
        mainBranch: process.env.COMMONS_MAIN_BRANCH,
        tools: ["submit", "status"],
        pollMs: VERDICT_POLL_MS,
        ...(detached() ? { detach: true } : {}),
    });
    if (detached()) {
        const hit = agent.failIfHit(instr);
        if (hit)
            finish(`NOT LANDED: ${hit} exists in the worktree`);
        const sha = await agent.git(["rev-parse", "HEAD"]);
        const result = await runner.call("submit", { summary: `${agent.taskId}: fake change`, wait: false });
        if (result.isError)
            finish(`NOT LANDED: ${firstLine(result.content.map((c) => c.text).join("\n"))}`);
        finish(`SUBMITTED ${sha}`);
    }
    let lastVerdict = "";
    for (let attempt = 1; attempt <= COMMONS_SUBMITS; attempt++) {
        const error = await agent.rebaseOnMain();
        if (error)
            finish(`NOT LANDED: ${error}`);
        const hit = agent.failIfHit(instr);
        if (hit)
            finish(`NOT LANDED: ${hit} exists in the worktree`);
        const sha = await agent.git(["rev-parse", "HEAD"]);
        const result = await runner.call("submit", { summary: `${agent.taskId}: fake change`, wait: true, timeoutMs: VERDICT_TIMEOUT_MS });
        lastVerdict = result.content.map((c) => c.text).join("\n");
        if (lastVerdict.includes("Verdict: landed"))
            finish(`LANDED ${sha}`);
        if (result.isError)
            break;
    }
    finish(`NOT LANDED: ${firstLine(lastVerdict)}`);
}
async function baselineArm(agent) {
    const instr = parseInstructions(taskBody());
    const notesDir = process.env.COMMONS_NOTES_DIR;
    if (notesDir) {
        mkdirSync(notesDir, { recursive: true });
        writeFileSync(resolve(notesDir, `${agent.taskId}.md`), `# ${agent.taskId}\n\nTouching: ${instr.writes.map((w) => w.path).join(", ") || "nothing"}\n`);
    }
    await agent.applyWrites(instr);
    let lastError = "";
    for (let attempt = 1; attempt <= BASELINE_PUSHES; attempt++) {
        const error = await agent.rebaseOnMain();
        if (error)
            finish(`NOT LANDED: ${error}`);
        const hit = agent.failIfHit(instr);
        if (hit)
            finish(`NOT LANDED: ${hit} exists in the worktree`);
        const sha = await agent.git(["rev-parse", "HEAD"]);
        const r = await agent.gitRaw(["push", "--quiet", "origin", "HEAD:main"]);
        if (r.code === 0)
            finish(`LANDED ${sha}`);
        lastError = r.stderr.trim();
    }
    finish(`NOT LANDED: push to main rejected ${BASELINE_PUSHES} times (${firstLine(lastError)})`);
}
export async function main() {
    const taskId = required("COMMONS_TASK");
    if (/^FAKE:\s*usage-limit\s*$/m.test(taskBody())) {
        console.log("You've hit your weekly limit · resets 7am");
        process.exit(1);
    }
    const arm = process.env.COMMONS_ARM ?? "commons";
    const agent = new Agent(process.env.COMMONS_WORKTREE ?? process.cwd(), taskId, process.env.COMMONS_HOST ?? "origin");
    const replay = /^FAKE:\s*replay\s+(\S+)\s*$/m.exec(taskBody());
    if (replay && arm !== "baseline")
        return replayArm(agent, replay[1]);
    if (arm === "baseline")
        return baselineArm(agent);
    if (arm === "queue")
        return queueArm(agent);
    return commonsArm(agent);
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main().catch((error) => {
        console.log(`NOT LANDED: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
//# sourceMappingURL=fake-agent.js.map