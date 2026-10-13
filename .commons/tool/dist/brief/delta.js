export const DEFAULT_REMOTE = "origin";
export function renderDelta(d, task, opts = {}) {
    const remote = opts.remote ?? DEFAULT_REMOTE;
    const lines = [`# Delta for ${task.id} (main ${d.mainCommit}, cursor ${d.cursor})`];
    lines.push("Landed since your base:");
    if (d.landings.length === 0)
        lines.push("- (nothing landed that touches your scope)");
    for (const landing of d.landings)
        lines.push(...renderLanding(landing));
    if (d.landings.some((l) => l.changed.some((c) => c.contractChanges.length > 0))) {
        lines.push("Contract guidance: the signatures above are now part of main. Keep every landed parameter in its position and type;" +
            " add yours without shifting or renaming existing ones. If two extensions compete for the same positional slot," +
            " accept both shapes (for example a function or an options object) instead of reordering, and keep both sets of tests passing.");
    }
    lines.push("Your bounced submissions:");
    if (d.bounces.length === 0)
        lines.push("- (none)");
    for (const bounce of d.bounces)
        lines.push(...renderBounce(bounce));
    lines.push(renderAdmission(d));
    lines.push("Update your worktree:");
    lines.push("```bash");
    lines.push(updateCommand(remote, opts.mainBranch));
    lines.push("```");
    return lines.join("\n") + "\n";
}
export function updateCommand(remote = DEFAULT_REMOTE, mainBranch = "main") {
    return `git fetch ${remote} ${mainBranch} && git rebase ${remote}/${mainBranch}`;
}
function renderLanding(landing) {
    const paths = landing.changed.map((c) => c.path);
    const out = [`- ${landing.taskId} (${short(landing.toMain)}): ${paths.length > 0 ? paths.join(", ") : "(no files)"}`];
    for (const change of landing.changed) {
        for (const cc of change.contractChanges) {
            out.push(`  - ${cc.symbol}: ${signature(cc.before, "(new)")} -> ${signature(cc.after, "(removed)")}`);
        }
    }
    return out;
}
function renderBounce(submission) {
    const verdict = submission.verdict;
    const failed = verdict?.failedTests ?? [];
    const conflicts = verdict?.conflicts ?? [];
    const out = [
        `- ${submission.id} commit ${short(submission.commit)}: failed tests: ${failed.length > 0 ? failed.join(", ") : "none"}; conflicts: ${conflicts.length > 0 ? conflicts.map((c) => c.path).join(", ") : "none"}`,
    ];
    const onlyCombined = verdict?.onlyFailsCombined ?? [];
    if (onlyCombined.length > 0)
        out.push(`  - only fails combined with landed work: ${onlyCombined.join(", ")}`);
    const excerpt = (verdict?.excerpt ?? "").replace(/\r\n/g, "\n").trim();
    if (excerpt.length > 0) {
        const fence = excerpt.includes("```") ? "````" : "```";
        out.push("  excerpt:", `  ${fence}`, ...excerpt.split("\n").map((line) => `  ${line.trimEnd()}`), `  ${fence}`);
    }
    return out;
}
function renderAdmission(d) {
    if (d.admitted)
        return "Admission: admitted";
    return d.blockedBy.length > 0 ? `Admission: blocked by ${d.blockedBy.join(", ")}` : "Admission: blocked";
}
function short(sha) {
    return sha.slice(0, 7);
}
function signature(s, empty) {
    const collapsed = s.replace(/\s+/g, " ").trim();
    return collapsed.length > 0 ? collapsed : empty;
}
//# sourceMappingURL=delta.js.map