// Change profiles for the scaling model (sim/scaling.ts) from a recorded run: per submission, the tests its changed
// code executes (verify/interaction.ts), the packages it touches, how long its own related check took, and whether it
// failed.
//
//   node --import tsx src/bench/sim/profiles.ts <recorded arm dir> <out.json>   (records: COMMONS_VERIFY_DIR or ~/.commons-bench/issues)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { impactOf } from "../../verify/interaction.js";
export function changeProfiles(arm, records) {
    const repo = join(arm, "host.git");
    const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
    const db = new DatabaseSync(join(arm, "coordinator.sqlite"), { readOnly: true });
    const cache = new DatabaseSync(join(arm, "cache.sqlite"), { readOnly: true });
    const subs = db.prepare("select task_id, commit_sha, parent_main, status from submissions order by created_at").all();
    const profiles = [];
    for (const s of subs) {
        const fork = git("merge-base", s.commit_sha, s.parent_main);
        const files = git("diff", "--name-only", `${fork}..${s.commit_sha}`).split("\n").filter(Boolean);
        const packages = [...new Set(files.map((f) => /^packages\/([^/]+)\//.exec(f)?.[1] ?? "(root)"))];
        // Its own check: the verdict stored under the submission's tree (its pre-verification).
        const tree = git("rev-parse", `${s.commit_sha}^{tree}`);
        const results = cache.prepare("select result from check_cache where tree = ?").all(tree)
            .map((r) => JSON.parse(r.result))
            .filter((r) => r.durationMs);
        const impact = impactOf(repo, fork, s.commit_sha, records);
        profiles.push({
            id: s.task_id,
            packages,
            tests: impact ? [...impact.tests] : null,
            wildcard: impact ? [...impact.wildcard] : null,
            checkMs: results[0]?.durationMs ?? null,
            failed: s.status === "bounced" || results.some((r) => !r.passed),
        });
    }
    db.close();
    cache.close();
    return profiles;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    const [arm, out] = process.argv.slice(2);
    if (!arm || !out) {
        console.error("usage: profiles.ts <recorded arm dir> <out.json>");
        process.exit(1);
    }
    const profiles = changeProfiles(resolve(arm), process.env.COMMONS_VERIFY_DIR ?? join(homedir(), ".commons-bench", "issues"));
    writeFileSync(out, JSON.stringify(profiles, null, 1) + "\n");
    console.log(`${profiles.length} change profiles -> ${out}`);
}
//# sourceMappingURL=profiles.js.map