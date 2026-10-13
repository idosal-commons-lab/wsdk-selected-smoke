// How this platform invokes its own CLI from inside a running process (e.g. the MCP server starting a detached
// pre-verification): the built entry when dist/ exists, else tsx over the TypeScript source.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/** platform/ (from src/adapter or dist/adapter). */
export const PLATFORM_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** Whether this module runs from the TypeScript source (tests, `tsx`) rather than from dist/. */
const FROM_SOURCE = /\/src\/adapter\/self\.ts$/.test(fileURLToPath(import.meta.url));
/** Arguments for `node` that run this platform's CLI with `args`, from the same flavor (source or build) as the caller. */
export function selfArgv(args) {
    if (!FROM_SOURCE && existsSync(join(PLATFORM_ROOT, "dist", "cli.js")))
        return [join(PLATFORM_ROOT, "bin", "commons.mjs"), ...args];
    let loader = "tsx";
    try {
        loader = import.meta.resolve("tsx");
    }
    catch {
        // bare specifier; node resolves it from the cwd
    }
    return ["--import", loader, join(PLATFORM_ROOT, "src", "cli.ts"), ...args];
}
//# sourceMappingURL=self.js.map