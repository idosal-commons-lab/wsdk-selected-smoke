// Copy-on-write directory clones: a prepared checkout (dependencies installed, builds restored) becomes a new
// worktree in seconds and shares its blocks until a file is written. On macOS the whole tree is cloned by one
// clonefile(2) call (APFS clones a directory hierarchy in the kernel), falling back to `cp -c`, which clones file by
// file; reflinks on btrfs/xfs on Linux (`cp --reflink=auto`); file systems without either get a plain copy.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
/**
 * clonefile(2) through Python's ctypes (no native module needed): one system call for the whole tree. Measured on
 * the workers-sdk base (172k files) under a load average of 83: 16 s, where `cp -c -R` took 50 s at a lighter load.
 */
const CLONEFILE = `import ctypes, sys
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
if libc.clonefile(sys.argv[1].encode(), sys.argv[2].encode(), 0) != 0:
    sys.exit(ctypes.get_errno() or 1)`;
let clonefileWorks;
/** Copy the tree at `src` to the new path `dst` (which must not exist), copy-on-write where supported. */
export async function cowCopy(src, dst) {
    if (existsSync(dst))
        throw new Error(`cowCopy: ${dst} already exists`);
    mkdirSync(dirname(dst), { recursive: true });
    if (process.platform === "darwin" && clonefileWorks !== false && process.env.COMMONS_CLONEFILE !== "0") {
        try {
            await run("python3", ["-I", "-c", CLONEFILE, src, dst], { maxBuffer: 1024 * 1024 });
            clonefileWorks = true;
            return;
        }
        catch {
            // Not APFS, no python3, or a cross-volume path: clone file by file instead.
            if (clonefileWorks === undefined)
                clonefileWorks = false;
            if (existsSync(dst))
                throw new Error(`cowCopy: clonefile left a partial ${dst}`);
        }
    }
    const args = process.platform === "darwin" ? ["-c", "-R", src, dst] : ["-R", "--reflink=auto", src, dst];
    await run("cp", args, { maxBuffer: 16 * 1024 * 1024 });
}
//# sourceMappingURL=cow.js.map