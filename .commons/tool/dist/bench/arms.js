/** `both` preserves the original comparison; `all` always uses the canonical three-arm order. */
export function selectArms(value, baselineFirst = false) {
    if (value === "all")
        return ["commons", "queue", "baseline"];
    if (value === "three")
        return ["commons", "github", "baseline"];
    if (value === "both")
        return baselineFirst ? ["baseline", "commons"] : ["commons", "baseline"];
    if (value === "commons" || value === "queue" || value === "github" || value === "baseline")
        return [value];
    throw new Error(`--arm must be one of commons|queue|github|baseline|both|all|three, got ${value}`);
}
export function maxResubmitsOption(value) {
    if (value === undefined)
        return undefined;
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n))
        throw new Error(`--max-resubmits must be a non-negative integer, got ${value}`);
    return n;
}
//# sourceMappingURL=arms.js.map