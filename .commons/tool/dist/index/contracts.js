import { extractFileSymbols } from "./symbols.js";
/**
 * Compare the exports of `before` and `after`. A null side means the file did not exist on that
 * side (added or removed): every export of the other side is in `symbolsChanged` and
 * `contractChanges` is empty.
 */
export function diffContracts(path, before, after) {
    const beforeExports = before === null ? [] : extractFileSymbols(path, before).exports;
    const afterExports = after === null ? [] : extractFileSymbols(path, after).exports;
    const beforeByName = new Map(beforeExports.map((e) => [e.name, e.signature]));
    const afterByName = new Map(afterExports.map((e) => [e.name, e.signature]));
    const symbolsChanged = [];
    const contractChanges = [];
    for (const [name, afterSignature] of afterByName) {
        const beforeSignature = beforeByName.get(name);
        if (beforeSignature === undefined)
            symbolsChanged.push(name);
        else if (beforeSignature !== afterSignature) {
            symbolsChanged.push(name);
            contractChanges.push({ symbol: name, before: beforeSignature, after: afterSignature });
        }
    }
    for (const name of beforeByName.keys())
        if (!afterByName.has(name))
            symbolsChanged.push(name);
    return { symbolsChanged, contractChanges };
}
//# sourceMappingURL=contracts.js.map