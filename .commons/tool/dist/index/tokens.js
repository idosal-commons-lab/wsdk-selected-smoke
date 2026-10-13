// Privacy tokens: keyed hashes of scope paths and symbols so the control plane never sees names.
import { createHmac, randomBytes } from "node:crypto";
function hmac(key, value) {
    return createHmac("sha256", key).update(value, "utf8").digest("hex");
}
/** HMAC-SHA256 hex of `path` and of `path#symbol` for each symbol; shape is preserved. */
export function tokenizeScopes(key, scopes) {
    return scopes.map((scope) => {
        const token = { path: hmac(key, scope.path) };
        if (scope.symbols)
            token.symbols = scope.symbols.map((symbol) => hmac(key, `${scope.path}#${symbol}`));
        return token;
    });
}
/** A fresh 256-bit repo key, hex encoded. Created by `commons init`; never leaves the data plane. */
export function createRepoKey() {
    return randomBytes(32).toString("hex");
}
//# sourceMappingURL=tokens.js.map