// The issues workload's check command (`related <files...> | ci <files...> | ci-base [dirs...] | since-base`): the
// product's verification planner (src/verify/check.ts) run in a benchmark checkout.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "../../verify/check.js";
export { changedSinceBase, checkCiFiles, checkFiles, recordCiBase, selfBuildOf } from "../../verify/check.js";
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
        process.exit(1);
    });
}
//# sourceMappingURL=check.js.map