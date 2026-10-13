// A GitHub lab: public copies of a benchmark workload's base in an organization, with a trimmed CI workflow on pull
// requests and merge groups and a merge queue in front of main, so the benchmark can compare Commons with what teams
// run (pull requests, Actions, GitHub's merge queue) instead of an emulation on one machine. Merge queues exist only
// on organization-owned public repositories (or Enterprise Cloud private ones), so the lab lives in an organization.
//
//   node --import tsx src/bench/lab/github.ts --org <org> --set bench/issues/core.json [--name core-lab]
//
// Everything here acts on GitHub through the gh CLI as its logged-in user: run it only for an organization made for this.
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { benchRoot } from "../issues/prepare.js";
import { githubGitEnv } from "../../executor/github-host.js";
const run = promisify(execFile);
/**
 * The lab's CI: one Linux job named `ci` on pull requests and merge groups. `turbo-affected` builds, type-checks and
 * tests the packages under packages/ that the change touches and every package depending on them, as the local
 * `--arm github` does: files outside packages/ (a changeset, docs) select nothing, except the root manifests, lockfile,
 * turbo and TypeScript configs, which select every package; fixtures and playgrounds are left out. (Turbo's own
 * `...[base]` counts any root file as a change to everything and ran the whole monorepo for a one-package change.)
 * `root-unit` runs the repository's type check and unit projects from the root (vuejs/core). `commons-selected` runs
 * Commons' own related check on the change's files (dependencies built, dependents type-checked, the tests the base's
 * coverage ties to the changed code), with the planner, the base records and the project profile vendored under
 * .commons/: GitHub's pull requests and merge queue with Commons' test selection, to separate the two.
 */
export function ciWorkflow(kind) {
    const base = "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}";
    const work = kind === "turbo-affected"
        ? `      - name: Affected packages
        id: affected
        shell: bash
        run: |
          changed=$(git diff --name-only "${base}" HEAD)
          if echo "$changed" | grep -qE '^(package\\.json|pnpm-lock\\.yaml|pnpm-workspace\\.yaml|turbo\\.json|tsconfig[^/]*\\.json)$'; then
            filters="--filter=./packages/*"
          else
            filters=""
            for dir in $(echo "$changed" | grep -oE '^packages/[^/]+' | sort -u); do
              if [ -f "$dir/package.json" ]; then filters="$filters --filter=...$(node -p "require('./$dir/package.json').name")"; fi
            done
          fi
          echo "filters=$filters" >> "$GITHUB_OUTPUT"
          echo "affected: \${filters:-none}"
      - name: Build, type-check and test them and their dependents
        if: steps.affected.outputs.filters != ''
        run: pnpm turbo run build check:type test:ci --continue=never \${{ steps.affected.outputs.filters }} --filter='!./fixtures/*' --filter='!./packages/vite-plugin-cloudflare/playground*'`
        : kind === "commons-selected"
            ? `      - name: Commons planner
        run: npm install --prefix .commons/tool --omit=dev --no-audit --no-fund --loglevel=error
      - name: Commons' related check of the change (build, type-check, the tests coverage ties to it)
        shell: bash
        env:
          COMMONS_VERIFY_DIR: \${{ github.workspace }}/.commons/records
          COMMONS_PROFILE: \${{ github.workspace }}/.commons/project.json
          COMMONS_CHECK_NICE: "0"
        run: |
          files=$(git diff --name-only "${base}" HEAD | grep -vE '^(\\.commons|\\.github)/' || true)
          if [ -z "$files" ]; then echo "nothing to check"; exit 0; fi
          echo "$files"
          node .commons/tool/dist/bench/issues/check.js related $files`
            : `      - run: pnpm check\n      - run: pnpm vitest run --project 'unit*'`;
    return `name: ci
on:
  pull_request:
  merge_group:
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
${work}
`;
}
/** The merge queue ruleset: groups of up to five, merged when CI passes on the group. */
export function mergeQueueRuleset(check = "ci") {
    return {
        name: "commons-lab merge queue",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
            {
                type: "merge_queue",
                parameters: {
                    check_response_timeout_minutes: 60,
                    grouping_strategy: "ALLGREEN",
                    max_entries_to_build: 5,
                    max_entries_to_merge: 5,
                    merge_method: "MERGE",
                    min_entries_to_merge: 1,
                    min_entries_to_merge_wait_minutes: 1,
                },
            },
            { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: check }] } },
        ],
    };
}
async function gh(args, input) {
    if (input === undefined)
        return (await run("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
    return new Promise((resolvePromise, reject) => {
        const child = execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
        child.stdin?.end(input);
    });
}
async function git(cwd, args, env) {
    return (await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })).stdout.trim();
}
/**
 * The planner (this package's dist with its two runtime dependencies), the base records of the repository's root commit
 * (coverage maps, declaration surfaces, CI base failures) and the project profile, under .commons/ in `work`.
 */
export async function vendorCommons(work, v) {
    const dir = join(work, ".commons");
    await mkdir(join(dir, "tool"), { recursive: true });
    await cp(v.dist, join(dir, "tool", "dist"), { recursive: true, filter: (src) => !src.endsWith(".map") && !src.endsWith(".d.ts") });
    const pkg = JSON.parse(await readFile(join(v.dist, "..", "package.json"), "utf8"));
    await writeFile(join(dir, "tool", "package.json"), JSON.stringify({ name: "commons-planner", private: true, type: "module", dependencies: pkg.dependencies ?? {} }, null, 2) + "\n");
    await mkdir(join(dir, "records", "tia"), { recursive: true });
    await mkdir(join(dir, "records", "surface"), { recursive: true });
    await mkdir(join(dir, "records", "ci"), { recursive: true });
    await cp(join(v.records, "tia", v.root), join(dir, "records", "tia", v.root), { recursive: true, filter: (src) => !src.endsWith(".work") && !src.includes(".work/") });
    await cp(join(v.records, "surface", `${v.root}.json`), join(dir, "records", "surface", `${v.root}.json`));
    if (existsSync(join(v.records, "ci", v.root)))
        await cp(join(v.records, "ci", v.root), join(dir, "records", "ci", v.root), { recursive: true });
    await cp(v.profile, join(dir, "project.json"));
}
export async function setupLabRepo(o) {
    const full = `${o.org}/${o.name}`;
    const exists = await gh(["repo", "view", full, "--json", "name"]).then(() => true, () => false);
    if (exists)
        throw new Error(`${full} already exists; pick another --name`);
    o.log(`creating ${full} (public)`);
    await gh(["repo", "create", full, "--public", "--description", "Commons lab: agents, pull requests and a merge queue on a benchmark workload"]);
    const url = `https://github.com/${full}.git`;
    const work = await mkdtemp(join(tmpdir(), "commons-lab-"));
    try {
        await git(work, ["init", "-q", "-b", "main"]);
        await git(work, ["fetch", "-q", resolve(o.source), o.commit]);
        await git(work, ["checkout", "-q", "FETCH_HEAD"]);
        await git(work, ["checkout", "-q", "-b", "main"]);
        // Upstream's own workflows would run on every pull request too (most need secrets the lab does not have) and take
        // the organization's concurrent-job budget: the lab's CI is the one workflow.
        await git(work, ["rm", "-r", "-q", "--ignore-unmatch", ".github/workflows"]);
        await mkdir(join(work, ".github", "workflows"), { recursive: true });
        await writeFile(join(work, ".github", "workflows", "commons-lab-ci.yml"), ciWorkflow(o.ci));
        await git(work, ["add", ".github/workflows"]);
        if (o.ci === "commons-selected") {
            if (!o.vendor)
                throw new Error("commons-selected needs the planner, records and profile to vendor");
            await vendorCommons(work, o.vendor);
            await git(work, ["add", "-f", ".commons"]);
        }
        await git(work, ["-c", "user.name=Commons Lab", "-c", "user.email=lab@commons.invalid", "commit", "-q", "-m", "commons lab: one CI workflow on pull requests and merge groups"]);
        const token = (await gh(["auth", "token"])).trim();
        o.log(`pushing ${o.commit.slice(0, 12)} and the CI workflow as main`);
        await git(work, ["push", "-q", url, "HEAD:refs/heads/main"], githubGitEnv(url, token));
        const main = await git(work, ["rev-parse", "HEAD"]);
        // Auto-merge is how a pull request enters the queue once its own CI passes (`gh pr merge --auto`).
        await gh(["api", "--method", "PATCH", `repos/${full}`, "-F", "allow_auto_merge=true", "-F", "delete_branch_on_merge=true"]);
        o.log("putting the merge queue in front of main");
        await gh(["api", "--method", "POST", `repos/${full}/rulesets`, "--input", "-"], JSON.stringify(mergeQueueRuleset()));
        return { url, main };
    }
    finally {
        await rm(work, { recursive: true, force: true });
    }
}
/**
 * Replace an existing lab repository's CI workflow on main. Main only takes changes through the merge queue, so the
 * ruleset is paused for the push and restored after, whatever happens.
 */
export async function updateLabCi(o) {
    const full = `${o.org}/${o.name}`;
    const url = `https://github.com/${full}.git`;
    const auth = githubGitEnv(url, (await gh(["auth", "token"])).trim());
    const work = await mkdtemp(join(tmpdir(), "commons-lab-"));
    const rulesets = JSON.parse(await gh(["api", `repos/${full}/rulesets`])).filter((r) => r.name === "commons-lab merge queue");
    const enforce = (state) => Promise.all(rulesets.map((r) => gh(["api", "--method", "PUT", `repos/${full}/rulesets/${r.id}`, "-f", `enforcement=${state}`])));
    try {
        await git(work, ["clone", "--quiet", "--depth", "1", url, "repo"], auth);
        const repo = join(work, "repo");
        await writeFile(join(repo, ".github", "workflows", "commons-lab-ci.yml"), ciWorkflow(o.ci));
        await git(repo, ["add", ".github/workflows"]);
        await git(repo, ["-c", "user.name=Commons Lab", "-c", "user.email=lab@commons.invalid", "commit", "-q", "-m", "commons lab: update the CI workflow"]);
        o.log(`pausing the merge queue of ${full} to update its CI on main`);
        await enforce("disabled");
        try {
            await git(repo, ["push", "-q", url, "HEAD:refs/heads/main"], auth);
        }
        finally {
            await enforce("active");
        }
        return await git(repo, ["rev-parse", "HEAD"]);
    }
    finally {
        await rm(work, { recursive: true, force: true });
    }
}
export async function main(argv) {
    const { values } = parseArgs({ args: argv, options: { org: { type: "string" }, set: { type: "string" }, name: { type: "string" }, ci: { type: "string" }, "update-ci": { type: "boolean", default: false } } });
    if (!values.org || !values.set)
        throw new Error("usage: --org <org> --set bench/issues/<repo>.json [--name <repo>] [--ci turbo-affected|root-unit|commons-selected] [--update-ci]");
    const set = JSON.parse(await readFile(resolve(values.set), "utf8"));
    const name = values.name ?? `${set.repo.split("/")[1]}-lab`;
    const source = benchRoot("issues", `${set.repo.split("/")[1]}-base-${set.baseCommit.slice(0, 12)}`);
    const commit = await git(source, ["rev-parse", "HEAD"]);
    const ci = values.ci ?? (set.repo === "vuejs/core" ? "root-unit" : "turbo-affected");
    if (values["update-ci"]) {
        console.log(JSON.stringify({ main: await updateLabCi({ org: values.org, name, ci, log: (l) => console.error(`[lab] ${l}`) }) }));
        return 0;
    }
    const vendor = ci === "commons-selected"
        ? { dist: fileURLToPath(new URL("../../../dist", import.meta.url)), records: benchRoot("issues"), root: commit, profile: resolve(values.set.replace(/\.json$/, ".profile.json")) }
        : undefined;
    const repo = await setupLabRepo({ org: values.org, name, source, commit, ci, log: (l) => console.error(`[lab] ${l}`), ...(vendor ? { vendor } : {}) });
    console.log(JSON.stringify(repo));
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=github.js.map