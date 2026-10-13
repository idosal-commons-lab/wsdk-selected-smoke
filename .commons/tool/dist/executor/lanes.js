// Verification lanes: which landed-but-unverified changes the post-landing check takes next, together.
//
// Landings whose changes touch a common workspace package form one lane, and a lane has at most one check running.
// Landings that arrive while their lane's check runs wait, and the lane's next check covers all of them at once, on
// the newest of their mains: the check of a later main contains every earlier landing of the lane, so one check
// replaces one check per landing, and a failure is bisected back to the landing that caused it. In the sixteenth run
// four of nineteen post-landing checks were of a main that a check of a newer main of the same package had already
// covered, and one integrator's landings queued behind its own two clones while another integrator's sat idle.
import { workspacePackages } from "../verify/dependents.js";
/** Lane of changes outside every workspace package (root configuration, changesets). */
export const ROOT_LANE = "(root)";
const packageDirsOf = new Map();
/** The workspace package directories of the changed paths (longest match), or the root lane when none matches. */
export function lanesOf(work, paths) {
    let dirs = packageDirsOf.get(work);
    if (!dirs) {
        try {
            dirs = workspacePackages(work)
                .map((p) => p.dir)
                .filter((d) => d !== "." && d !== "")
                .sort((a, b) => b.length - a.length);
        }
        catch {
            dirs = [];
        }
        packageDirsOf.set(work, dirs);
    }
    const out = new Set();
    for (const path of paths) {
        const dir = dirs.find((d) => path.startsWith(`${d}/`));
        if (dir)
            out.add(dir);
    }
    return out.size > 0 ? [...out].sort() : [ROOT_LANE];
}
/**
 * The next lane to check: the landings connected to the oldest waiting landing through shared packages, provided no
 * running check holds any of their packages; at most `max`, oldest first. Null when every waiting lane is busy.
 * `pending` is in landing order.
 */
export function nextLane(pending, running, max) {
    const busy = new Set(running.flat());
    // Union-find over packages: two landings are in one lane when their packages connect.
    const parent = new Map();
    const find = (p) => {
        let root = p;
        while (parent.get(root) !== root)
            root = parent.get(root);
        parent.set(p, root);
        return root;
    };
    for (const e of pending)
        for (const p of e.packages)
            if (!parent.has(p))
                parent.set(p, p);
    for (const e of pending)
        for (const p of e.packages.slice(1))
            parent.set(find(p), find(e.packages[0]));
    const blocked = new Set();
    for (const e of pending)
        if (e.packages.some((p) => busy.has(p)))
            blocked.add(find(e.packages[0]));
    for (const e of pending) {
        const root = find(e.packages[0]);
        if (blocked.has(root))
            continue;
        return pending.filter((x) => find(x.packages[0]) === root).slice(0, Math.max(1, max));
    }
    return null;
}
//# sourceMappingURL=lanes.js.map