// Score a finished run's final main again with the current scorer (the hidden tests of every task), for when the
// scorer was wrong: writes official-rescored.json beside the run's report and prints passes per run.
//
//   node --import tsx src/bench/issues/rescore.ts --set bench/issues/workers-sdk.json <arm dir>...
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { git } from "../../executor/git.js";
import { scoreIssues } from "./official.js";
import { prepareIssues } from "./prepare.js";
export async function main(argv) {
    const { values, positionals } = parseArgs({ args: argv, options: { set: { type: "string" } }, allowPositionals: true });
    if (!values.set || positionals.length === 0)
        throw new Error("usage: --set bench/issues/<repo>.json <arm dir with report.json and host.git>...");
    const workload = await prepareIssues({ setPath: resolve(values.set) });
    Object.assign(process.env, workload.env);
    for (const arm of positionals.map((p) => resolve(p))) {
        const report = JSON.parse(readFileSync(join(arm, "report.json"), "utf8"));
        const ids = new Set(report.tasks.map((t) => t.id));
        const out = join(arm, "rescore");
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
        const src = join(out, "src");
        await git(out, ["clone", "--quiet", "--no-checkout", join(arm, "host.git"), src]);
        const results = await scoreIssues({
            repo: src,
            commit: report.finalMain,
            set: { ...workload.set, tasks: workload.set.tasks.filter((t) => ids.has(t.id)) },
            hiddenDir: workload.hiddenDir,
            env: workload.env,
            prepareCheckout: workload.prepareCheckout,
            out: join(out, "official"),
        });
        writeFileSync(join(arm, "official-rescored.json"), JSON.stringify(results, null, 2) + "\n");
        rmSync(join(out, "official", "checkout"), { recursive: true, force: true });
        rmSync(src, { recursive: true, force: true });
        const was = (() => {
            try {
                return JSON.parse(readFileSync(join(arm, "official.json"), "utf8")).filter((r) => r.passed).length;
            }
            catch {
                return "?";
            }
        })();
        const errors = results.filter((r) => r.error).length;
        console.log(`${arm}: ${results.filter((r) => r.passed).length}/${results.length} hidden test sets pass (was ${was}); ${errors} with errors`);
    }
    return 0;
}
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=rescore.js.map