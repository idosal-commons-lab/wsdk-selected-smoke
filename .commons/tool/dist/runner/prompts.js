// Agent prompts for the benchmark arms. All arms receive identical task text, budgets, and test commands;
// only the coordination mechanism differs.
/** Step 2: implement, and either run the related tests locally or leave verification to the platform. */
function implementStep(c) {
    if (c.trustQueue) {
        return `2. Implement the task in this worktree. You do not need to run the related test suite before submitting: the platform runs it on your commit the moment you submit, and ${c.detach ? "resumes you with the failing tests if any fail" : "returns the failing tests in the verdict"}. For fast feedback while editing, run only the single test file you are changing (the full related run is \`${c.relatedCommand}\`).`;
    }
    return `2. Implement the task in this worktree. Run the related tests locally with:
   ${c.relatedCommand}`;
}
function worktreeNote(c) {
    return c.worktree
        ? `Your worktree is \`${c.worktree}\`. The current directory is only a launch pad: start every shell command with \`cd ${c.worktree}\` and use absolute paths under it for file tools. Never touch files outside it.\n\n`
        : "";
}
function constraints(withClaims) {
    return `Constraints:
- Work only in this worktree. Do not install packages, do not use the network, ${withClaims ? "do not modify files outside your scope without calling `claim` first" : "keep changes within your task's scope"}.
- Do not edit, revert, or "fix" other agents' files unless the task requires it${withClaims ? " and you have claimed them" : ""}.
- Keep existing tests passing. Add focused tests for your change in the repository's existing test style.
- Do not spawn sub-agents, do not use any codex, advisor, or consultation skills, do not open pull requests.
- Other agents share this machine: never kill processes you did not start (no \`pkill\`, \`killall\`, or \`kill\` of unknown pids); if a test run hangs, narrow it or wait.`;
}
function retryInstruction(max) {
    if (max !== undefined) {
        if (!Number.isSafeInteger(max) || max < 0)
            throw new Error("maxResubmits must be a non-negative integer");
        return `Do this at most ${max} times, within your turn and time budget. Stop with NOT LANDED when the retry limit is reached or the budget is nearly exhausted.`;
    }
    return "Keep going as long as your turn and time budget allow. Stop with NOT LANDED when the budget is nearly exhausted.";
}
/** Steps 5 and 6: wait for the verdict in the session, or submit and stop (a bounce resumes the session). */
function submitStep(c, withDelta) {
    if (c.detach) {
        return `5. Call \`submit\` with a one-line summary and \`wait: false\`. Do not wait for the verdict and do not poll \`status\`: the platform merges your commit onto the current main, runs the tests on the combination, and lands it. If it bounces, this session is resumed with the verdict.
6. Finish immediately with exactly one line: \`SUBMITTED <commit sha>\` (or \`NOT LANDED: <one-sentence reason>\` if you could not produce a commit).`;
    }
    const bounce = withDelta ? "read the failed tests, conflicts, and delta in the verdict" : "read the failed tests and conflicts in the verdict";
    return `5. Call \`submit\` with a one-line summary and \`wait: true\`. The platform merges your commit onto the current main, runs the tests on the combination, and returns a verdict.
   - "landed": you are done.
   - "bounced": ${bounce}; \`git fetch origin main && git rebase origin/main\`, fix, commit, and call \`submit\` again. ${retryInstruction(c.maxResubmits)}
6. Finish with exactly one line: \`LANDED <commit sha>\` or \`NOT LANDED: <one-sentence reason>\`.`;
}
/** The message a bounced, detached agent is resumed with. */
export function resumePrompt(c) {
    const limit = c.remaining > 0 ? `You can be resumed ${c.remaining} more time${c.remaining === 1 ? "" : "s"} after this one.` : "This is your last attempt.";
    const update = c.withDelta
        ? "Call `delta` to see what landed in your scope since you submitted, then `git fetch origin main && git rebase origin/main`"
        : "`git fetch origin main && git rebase origin/main`";
    const body = `Your submission for task "${c.taskId}" was bounced by the platform.

${c.verdict.trim()}

Do this now: ${update}, fix what the verdict shows, re-run the related tests, commit, and call \`submit\` again with \`wait: false\`. ${limit}
Then finish immediately with exactly one line: \`SUBMITTED <commit sha>\`, or \`NOT LANDED: <one-sentence reason>\` if it cannot be fixed.`;
    if (!c.original)
        return body;
    return `${c.original}

---
UPDATE (this session continues the work above; the worktree already holds your previous commit${c.worktree ? ` in \`${c.worktree}\`` : ""}):

${body}`;
}
export function commonsPrompt(c) {
    return `You are one of several coding agents working concurrently on this repository. A coordination server ("Commons") plans the work, merges every submission, runs the tests, and lands what passes on main. Your job is to implement ONE task end to end and get it landed.

${worktreeNote(c)}Your task id is "${c.taskId}": ${c.title}

Workflow (follow it exactly):
1. ${c.brief !== undefined ? "Your brief is at the end of this message. It contains your full task, your write scope, what other agents are doing right now, the rules, and the exports in your scope (the `brief` tool returns a fresh copy if you need one)." : "Call the `brief` tool first. It contains your full task, your write scope, what other agents are doing right now, the rules, and the exports in your scope."}
${implementStep(c)}
3. ${c.deltaViaHook ? "Landed changes that touch your scope reach you automatically after your tool calls, as a delta with the exact rebase command. When one arrives, run `git fetch origin main && git rebase origin/main`, re-run the related tests, and fix anything that broke (`delta` returns the same on demand; you do not need to call it otherwise)." : "Before you commit, call `delta`. If it lists landed changes that touch your scope, run `git fetch origin main && git rebase origin/main`, re-run the related tests, and fix anything that broke."}
4. Commit everything in ONE commit on your current branch (\`git add -A && git commit -m "<message>"\`). Never push to main yourself.
${submitStep(c, true)}

${constraints(true)}${c.brief !== undefined ? `

---
## Brief

${c.brief.trim()}` : ""}`;
}
export function queuePrompt(c) {
    return `You are one of several coding agents working concurrently on this repository. A merge queue merges every submission, runs the tests, and lands what passes on main. Your job is to implement ONE task end to end and get it landed.

${worktreeNote(c)}Your task id is "${c.taskId}": ${c.title}

Workflow (follow it exactly):
1. Your task is below:

${c.body}

${implementStep(c)}
3. Before you commit, run \`git fetch origin main && git rebase origin/main\`${c.trustQueue ? "" : ", re-run the related tests"}, and fix anything that broke.
4. Commit everything in ONE commit on your current branch (\`git add -A && git commit -m "<message>"\`). Never push to main yourself.
${submitStep(c, false)}

${constraints(false)}`;
}
export function baselinePrompt(c) {
    return `You are one of several coding agents working concurrently on this repository. Each agent has its own branch cloned from the same origin. There is no coordinator: you must integrate your own work into origin/main and keep main green.

${worktreeNote(c)}Your task id is "${c.taskId}": ${c.title}

${c.body}
${c.dependsOn?.length ? `\nYour task depends on producer tasks: ${c.dependsOn.join(", ")}. ${c.dependenciesLanded !== false ? "Those producers are already on origin/main when you start; build on their landed work." : "Dependency gating is disabled; check origin/main and the shared notes for their progress."}\n` : ""}

Coordination with the other agents (${c.peerTaskIds.join(", ")}):
- A shared notes directory at ${c.notesDir} holds one file per agent (\`<taskId>.md\`). Read the others' notes when you start and again before you integrate. Write your own note early (files, functions, and interfaces you are changing) and keep it current.
- You may inspect other agents' branches: \`git fetch origin\` then \`git log origin/task/<taskId>\` and \`git diff origin/main...origin/task/<taskId>\`.

Workflow:
1. Implement the task in this worktree. Run the related tests locally with:
   ${c.relatedCommand}
2. Integrate: \`git fetch origin && git rebase origin/main\`. Resolve conflicts, re-run the related tests, then \`git push origin HEAD:main\`.
3. If the push is rejected because main moved, fetch, rebase, re-test, and push again. ${retryInstruction(c.maxResubmits)}
4. Finish with exactly one line: \`LANDED <commit sha>\` or \`NOT LANDED: <one-sentence reason>\`.

${constraints(false)}`;
}
//# sourceMappingURL=prompts.js.map