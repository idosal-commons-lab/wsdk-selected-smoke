import { LOCAL_TASK_REF_PREFIX, taskRefFor } from "../executor/task-ref.js";
export const MAX_EXEMPLAR_LINES = 160;
export const MAX_OTHER_NEIGHBORS = 24;
/** Up to this many neighbors are always listed in full; beyond it, only those touching the task's scope are. */
export const MAX_FULL_NEIGHBORS = 6;
/** Marker that separates the repo section from the task section. */
export const TASK_HEADING = "\n## Task ";
export const DEFAULT_TREE_DEPTH = 2;
export const MAX_EXPORTS_PER_FILE = 20;
export const MAX_SIGNATURE_CHARS = 160;
export const MAX_ENTRIES_PER_DIR = 60;
const RULES = [
    "- Edit only files in your scope. Call `claim` before touching anything else.",
    "- What lands in your scope reaches you as a delta (injected after your tool calls; `delta` returns it on demand). When one arrives, rebase as it says.",
    "- Make one commit on your branch, then call `submit`. The platform merges, tests, and lands it; you get a verdict.",
    "- Do not merge or push to main yourself. Do not edit other tasks' files.",
];
export function renderBrief(meta, index, opts = {}) {
    const treeDepth = Math.max(1, Math.floor(opts.treeDepth ?? DEFAULT_TREE_DEPTH));
    const repoSection = renderRepoSection(meta.repo, index, treeDepth);
    const taskSection = renderTaskSection(meta, index, opts);
    return `${repoSection}\n${taskSection}`;
}
/** Everything before the first task heading: the byte-stable, task-independent section. */
export function briefPrefix(brief) {
    const at = brief.indexOf(TASK_HEADING);
    return at < 0 ? brief : brief.slice(0, at);
}
// ---------------------------------------------------------------------------
// Section 1: repo
function renderRepoSection(repo, index, treeDepth) {
    const lines = [
        `# ${repo.name} @ ${repo.mainCommit}`,
        `Test: ${repo.testCommand}`,
        `Related: ${repo.relatedTestCommand ? repo.relatedTestCommand : "(none)"}`,
        "Tree:",
        ...renderTree(index, treeDepth),
        "Rules:",
        ...RULES,
    ];
    return lines.join("\n") + "\n";
}
function newNode(name) {
    return { name, dirs: new Map(), files: [], fileCount: 0 };
}
function buildTree(paths) {
    const root = newNode("");
    for (const path of paths) {
        const parts = path.split("/").filter((p) => p.length > 0);
        if (parts.length === 0)
            continue;
        let node = root;
        node.fileCount += 1;
        for (let i = 0; i < parts.length - 1; i++) {
            let child = node.dirs.get(parts[i]);
            if (!child) {
                child = newNode(parts[i]);
                node.dirs.set(parts[i], child);
            }
            child.fileCount += 1;
            node = child;
        }
        node.files.push(parts[parts.length - 1]);
    }
    return root;
}
function renderTree(index, treeDepth) {
    if (!index)
        return ["(no index)"];
    const paths = uniqueSorted(index.files.map((f) => normalizePath(f.path)).filter((p) => p.length > 0));
    if (paths.length === 0)
        return ["(empty index)"];
    const out = [];
    renderNode(buildTree(paths), 0, treeDepth, out);
    return out;
}
function renderNode(node, level, treeDepth, out) {
    const indent = "  ".repeat(level);
    const dirs = [...node.dirs.values()].sort((a, b) => compare(a.name, b.name));
    const files = uniqueSorted(node.files);
    const total = dirs.length + files.length;
    let shown = 0;
    for (const dir of dirs) {
        if (shown >= MAX_ENTRIES_PER_DIR)
            break;
        shown += 1;
        if (level + 1 < treeDepth) {
            out.push(`${indent}${dir.name}/`);
            renderNode(dir, level + 1, treeDepth, out);
        }
        else {
            out.push(`${indent}${dir.name}/ (${plural(dir.fileCount, "file")})`);
        }
    }
    for (const file of files) {
        if (shown >= MAX_ENTRIES_PER_DIR)
            break;
        shown += 1;
        out.push(`${indent}${file}`);
    }
    if (shown < total)
        out.push(`${indent}... (+${total - shown} more)`);
}
// ---------------------------------------------------------------------------
// Section 2: task
function renderTaskSection(meta, index, opts = {}) {
    const { task } = meta;
    const mainBranch = opts.mainBranch ?? "main";
    const lines = [`## Task ${task.id}: ${task.title}`];
    const body = task.body.trim();
    if (body)
        lines.push(body);
    lines.push(`Base commit: ${task.baseCommit}`);
    lines.push("Your scope (writes):");
    lines.push(...listOr(task.writes.map(scopeLine), "(none declared; call `claim` with the files you need)"));
    lines.push("Reads:");
    lines.push(...listOr(task.reads.map(scopeLine), "(none)"));
    lines.push("Blocked by:");
    lines.push(...listOr(meta.blockedBy.map((t) => `${t.id}: ${t.title}`), "(none)"));
    lines.push("Depends on:");
    lines.push(...listOr(meta.dependsOn.map((t) => {
        const sha = t.landedCommit?.slice(0, 7);
        const state = sha ? `landed ${sha}; see it with: git fetch origin ${mainBranch} && git show ${sha}` : t.status;
        return `${t.id}: ${t.title} [${state}] writes: ${scopesInline(t.writes)}`;
    }), "(none)"));
    const exemplars = meta.exemplars ?? [];
    if (exemplars.length > 0) {
        lines.push("Exemplar (a landed change of the same kind; follow its shape and test style):");
        for (const e of exemplars) {
            lines.push(`- ${e.taskId}: ${e.title} (landed as ${e.toMain.slice(0, 7)}; full diff: git fetch origin ${mainBranch} && git diff ${e.fromMain.slice(0, 7)} ${e.toMain.slice(0, 7)})`);
            const diff = opts.exemplarDiffs?.[e.toMain];
            if (diff && diff.trim()) {
                const all = diff.trimEnd().split("\n");
                lines.push("```diff");
                lines.push(...all.slice(0, MAX_EXEMPLAR_LINES));
                if (all.length > MAX_EXEMPLAR_LINES)
                    lines.push(`... (+${all.length - MAX_EXEMPLAR_LINES} lines; see the full diff above)`);
                lines.push("```");
            }
        }
    }
    // Neighbors that touch the task's scope (or that it depends on) are listed in full; the rest are counted, so the
    // brief stays small as the swarm grows.
    const mine = [...task.writes, ...task.reads];
    const depIds = new Set(meta.dependsOn.map((d) => d.id));
    const collapse = meta.neighbors.length > MAX_FULL_NEIGHBORS;
    const relevant = collapse ? meta.neighbors.filter((t) => depIds.has(t.id) || t.writes.some((w) => mine.some((m) => scopesTouch(m, w)))) : meta.neighbors;
    const others = meta.neighbors.filter((t) => !relevant.includes(t));
    lines.push("Neighbors (active, do not touch):");
    lines.push(...listOr(relevant.map((t) => `${t.id}: ${t.title}: ${scopesInline(t.writes)}${t.submittedCommit ? ` (submitted ${t.submittedCommit.slice(0, 7)}; see it with: git fetch origin ${taskRefFor(opts.taskRefPrefix ?? LOCAL_TASK_REF_PREFIX, t.id)} && git diff origin/${mainBranch}...FETCH_HEAD)` : ""}`), others.length > 0 ? "(none touch your scope)" : "(none)"));
    if (others.length > 0) {
        const shown = others.slice(0, MAX_OTHER_NEIGHBORS).map((t) => t.id);
        lines.push(`${others.length} other active task${others.length === 1 ? "" : "s"} elsewhere in the repository: ${shown.join(", ")}${others.length > shown.length ? `, +${others.length - shown.length} more` : ""}`);
    }
    const contention = sharedWrites(task.writes, meta.neighbors);
    if (contention.length > 0) {
        lines.push("Contention (other active tasks write the same symbols):");
        for (const c of contention)
            lines.push(`- ${c.path}${c.symbol ? `: ${c.symbol}` : ""} also written by ${c.tasks.join(", ")}`);
        lines.push("Compose, do not collide: make your change additive and position-stable (new optional parameters or options-object fields, no reordering or renaming of existing ones), so every concurrent extension can land on top of yours.");
    }
    lines.push("Exports in your scope:");
    lines.push(...renderExports(task.writes, index));
    lines.push("Submit: commit on your branch, then call submit({summary}).");
    return lines.join("\n") + "\n";
}
/** Two scopes touch when they name the same path and either has no symbols or they share one. */
function scopesTouch(a, b) {
    if (normalizePath(a.path) !== normalizePath(b.path))
        return false;
    if (!a.symbols?.length || !b.symbols?.length)
        return true;
    return a.symbols.some((s) => b.symbols.includes(s));
}
/** Paths/symbols in `writes` that at least one neighbor also writes (file-level overlap when either side has no symbols). */
function sharedWrites(writes, neighbors) {
    const out = [];
    for (const w of writes) {
        const path = normalizePath(w.path);
        const symbols = w.symbols && w.symbols.length > 0 ? w.symbols : [undefined];
        for (const symbol of symbols) {
            const tasks = neighbors
                .filter((n) => n.writes.some((nw) => {
                if (normalizePath(nw.path) !== path)
                    return false;
                if (!symbol || !nw.symbols || nw.symbols.length === 0)
                    return true;
                return nw.symbols.includes(symbol);
            }))
                .map((n) => n.id);
            if (tasks.length > 0)
                out.push(symbol ? { path, symbol, tasks } : { path, tasks });
        }
    }
    return out;
}
function scopeLine(scope) {
    const path = normalizePath(scope.path);
    return scope.symbols && scope.symbols.length > 0 ? `${path}: ${scope.symbols.join(", ")}` : path;
}
function scopesInline(scopes) {
    if (scopes.length === 0)
        return "(none)";
    return scopes
        .map((s) => {
        const path = normalizePath(s.path);
        return s.symbols && s.symbols.length > 0 ? `${path} (${s.symbols.join(", ")})` : path;
    })
        .join(", ");
}
function renderExports(writes, index) {
    if (!index)
        return ["- (no index)"];
    const out = [];
    const seen = new Set();
    for (const scope of writes) {
        const path = normalizePath(scope.path);
        if (!path || seen.has(path))
            continue;
        seen.add(path);
        const file = lookupFile(index, path);
        if (!file)
            continue;
        out.push(`- ${path}`);
        if (file.exports.length === 0) {
            out.push("  - (no exports)");
            continue;
        }
        const wanted = new Set(scope.symbols ?? []);
        // Stable partition: symbols named in the scope first, then the rest in index order.
        const ordered = [...file.exports.filter((e) => wanted.has(e.name)), ...file.exports.filter((e) => !wanted.has(e.name))];
        for (const e of ordered.slice(0, MAX_EXPORTS_PER_FILE)) {
            const signature = collapseWhitespace(e.signature);
            out.push(`  - ${e.name}: ${truncate(signature.length > 0 ? signature : e.kind, MAX_SIGNATURE_CHARS)}`);
        }
        if (ordered.length > MAX_EXPORTS_PER_FILE)
            out.push(`  - ... (+${ordered.length - MAX_EXPORTS_PER_FILE} more)`);
    }
    return out.length > 0 ? out : ["- (none)"];
}
function lookupFile(index, path) {
    const direct = index.byPath?.get(path);
    if (direct)
        return direct;
    return index.files.find((f) => normalizePath(f.path) === path);
}
// ---------------------------------------------------------------------------
// Helpers
function listOr(items, empty) {
    return items.length > 0 ? items.map((i) => `- ${i}`) : [`- ${empty}`];
}
export function normalizePath(path) {
    return path.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "").replace(/\/+/g, "/");
}
function collapseWhitespace(s) {
    return s.replace(/\s+/g, " ").trim();
}
function truncate(s, max) {
    return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}
function plural(n, noun) {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
/** Code-unit comparison: deterministic across locales and ICU builds. */
function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function uniqueSorted(items) {
    return [...new Set(items)].sort(compare);
}
//# sourceMappingURL=brief.js.map