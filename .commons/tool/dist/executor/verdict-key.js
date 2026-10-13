// Closure-addressed verdicts. A related check's outcome is a function of the files its tests can observe: the
// dependency closure of the changed files (upward through importers, which is where the tests are; downward
// through their dependencies), the non-code files of the packages that closure lives in (fixtures, snapshots,
// data a test reads), and the configuration that governs every run (manifests, lockfiles, test config at the
// repository root or in those packages). Keying a verdict by the content of those files instead of by the tree
// lets it carry between trees that agree on them: an agent's own test run on its worktree reaches the merge
// candidate, and a batch's verdict survives landings elsewhere in the repository. Anything the index cannot
// see keeps the tree key, which never transfers.
import { createHash } from "node:crypto";
import { git } from "./git.js";
import { FOOTPRINT_EXCLUDE, GLOBAL_PATH } from "./footprint.js";
/** Files the index parses; everything else is data a test may read. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** Every blob of a tree, from one `ls-tree`. */
export async function blobsOf(work, tree) {
    const out = await git(work, ["ls-tree", "-r", "-z", tree], { maxBuffer: 256 * 1024 * 1024 });
    const blobs = new Map();
    for (const entry of out.split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab < 0)
            continue;
        const [, type, sha] = entry.slice(0, tab).split(" ");
        if (type === "blob" && sha)
            blobs.set(entry.slice(tab + 1), sha);
    }
    return blobs;
}
/**
 * The key, or null when the closure is unknown: no index, an incomplete index, no scoped files (a full-suite
 * check, whose closure is the tree), or a change to a global path.
 */
export function closureKey(i) {
    if (!i.index || i.changedFiles.length === 0)
        return null;
    const changed = [...new Set(i.changedFiles.map(norm))].sort();
    if (changed.some((p) => GLOBAL_PATH.test(p)))
        return null;
    const closure = i.index.closureOf(changed.map((path) => ({ path })));
    if (closure === null)
        return null;
    const files = new Set(changed);
    for (const entry of closure)
        files.add(entry.includes("#") ? entry.slice(0, entry.indexOf("#")) : entry);
    const packageOf = packageResolver(i.blobs);
    const packages = new Set();
    for (const f of files)
        packages.add(packageOf(f));
    for (const path of i.blobs.keys()) {
        if (FOOTPRINT_EXCLUDE.test(path))
            continue;
        const pkg = packageOf(path);
        if (GLOBAL_PATH.test(path)) {
            if (pkg === "" || packages.has(pkg))
                files.add(path);
        }
        else if (!CODE_FILE.test(path) && packages.has(pkg))
            files.add(path);
    }
    const h = createHash("sha256");
    h.update(`check ${i.checkId}\n`);
    h.update(`files ${changed.join(" ")}\n`);
    for (const f of [...files].sort())
        h.update(`${f}\0${i.blobs.get(f) ?? "-"}\n`);
    return `closure:${h.digest("hex")}`;
}
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
/** The nearest ancestor directory holding a package.json ("" for the repository root), memoized per directory. */
function packageResolver(blobs) {
    const memo = new Map();
    const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    const resolveDir = (dir) => {
        const known = memo.get(dir);
        if (known !== undefined)
            return known;
        const result = dir === "" ? "" : blobs.has(`${dir}/package.json`) ? dir : resolveDir(dirOf(dir));
        memo.set(dir, result);
        return result;
    };
    return (path) => resolveDir(dirOf(path));
}
//# sourceMappingURL=verdict-key.js.map