// Claude Code hook handler: delivers deltas into a running agent at its next safe boundary
// (PostToolUse / UserPromptSubmit / SessionStart) and refuses to stop before the task was submitted.
// Input is the hook JSON Claude Code writes to stdin; output is the hook JSON it reads from stdout.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderDelta } from "../brief/delta.js";
import { renderVerdict } from "./mcp.js";
export const TASK_STATE_FILE = ".commons-task.json";
export async function readHookState(worktree) {
    try {
        return JSON.parse(await readFile(join(worktree, TASK_STATE_FILE), "utf8"));
    }
    catch {
        return null;
    }
}
export async function writeHookState(worktree, state) {
    await writeFile(join(worktree, TASK_STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}
const DELTA_EVENTS = new Set(["PostToolUse", "UserPromptSubmit", "SessionStart", "PostToolBatch"]);
/** Tools whose completion is a natural boundary for new information. */
const BOUNDARY_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Bash", "NotebookEdit"]);
export async function handleHook(input, opts) {
    const now = opts.now ?? Date.now;
    const event = input.hook_event_name ?? "";
    const state = (await readHookState(opts.worktree)) ?? { taskId: opts.taskId };
    if (event === "Stop") {
        if (input.stop_hook_active)
            return null;
        const status = await opts.client.taskStatus(opts.repoId, opts.taskId);
        const landed = status.task.status === "landed" || status.submissions.some((s) => s.status === "landed");
        if (landed)
            return null;
        const pending = status.submissions.some((s) => s.status === "queued" || s.status === "leased");
        if (pending) {
            if (opts.detach)
                return null;
            return { decision: "block", reason: "Your submission is still being integrated. Call the `status` tool (or `submit` with wait: true) and handle the verdict before finishing." };
        }
        // Best-of-N candidate mode: the candidate is recorded for the runner, which submits the chosen one.
        if (opts.candidateFile && existsSync(opts.candidateFile))
            return null;
        if (opts.detach) {
            // A bounce that arrived before the agent could stop is cheapest handled here, with the session still warm;
            // one that arrives later reaches it through the runner's resume.
            const bounced = [...status.submissions].sort((a, b) => b.createdAt - a.createdAt).find((s) => s.status === "bounced");
            if (bounced) {
                return {
                    decision: "block",
                    reason: `Your submission was bounced before you stopped.\n${renderVerdict(bounced, undefined, true)}Fix it now, commit, call \`submit\` again with wait: false, then finish with \`SUBMITTED <commit sha>\`. If it cannot be fixed, finish with \`NOT LANDED: <reason>\`.`,
                };
            }
            return {
                decision: "block",
                reason: "Your task has not been submitted. Commit your work on this branch and call the `submit` tool with wait: false, then finish with `SUBMITTED <commit sha>`. If the task is truly impossible, finish with `NOT LANDED: <reason>`.",
            };
        }
        return {
            decision: "block",
            reason: "Your task has not landed. Commit your work on this branch and call the `submit` tool with wait: true; if the verdict is bounced, fix and resubmit. If the task is truly impossible, finish with `NOT LANDED: <reason>`.",
        };
    }
    if (!DELTA_EVENTS.has(event))
        return null;
    if (event === "PostToolUse" && input.tool_name && !BOUNDARY_TOOLS.has(input.tool_name))
        return null;
    const minInterval = opts.minIntervalMs ?? 15_000;
    if (event === "PostToolUse" && state.lastCheckAt && now() - state.lastCheckAt < minInterval)
        return null;
    const cursor = state.deltaCursor ?? 0;
    const delta = await opts.client.delta(opts.repoId, opts.taskId, cursor);
    state.lastCheckAt = now();
    const interesting = delta.landings.length > 0 || delta.bounces.length > 0;
    if (interesting)
        state.deltaCursor = delta.cursor;
    await writeHookState(opts.worktree, state);
    if (!interesting)
        return null;
    const status = await opts.client.taskStatus(opts.repoId, opts.taskId);
    const text = renderDelta(delta, status.task, { remote: opts.remote ?? "origin", mainBranch: opts.mainBranch });
    return {
        hookSpecificOutput: {
            hookEventName: event,
            additionalContext: `[Commons] New information relevant to your scope arrived. Act on it before continuing:\n\n${text}`.slice(0, 9_500),
        },
    };
}
//# sourceMappingURL=hook.js.map