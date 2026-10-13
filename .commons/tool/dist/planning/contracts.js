function normalizePath(path) {
    return path.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "").replace(/\/+/g, "/");
}
function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function slug(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}
export function synthesizeContracts(tasks, opts = {}) {
    const minWriters = opts.minWriters ?? 3;
    if (!Number.isInteger(minWriters) || minWriters < 1)
        throw new Error("minWriters must be a positive integer");
    const groups = new Map();
    for (const task of tasks) {
        for (const write of task.writes ?? []) {
            const path = normalizePath(write.path);
            for (const symbol of write.symbols?.length ? write.symbols : [""]) {
                const key = JSON.stringify([path, symbol]);
                let group = groups.get(key);
                if (!group) {
                    group = { path, symbol, writers: new Map() };
                    groups.set(key, group);
                }
                group.writers.set(task.id, task);
            }
        }
    }
    const usedIds = new Set(tasks.map((t) => t.id));
    const contracts = [];
    const before = new Map();
    const dependencies = new Map();
    const ordered = [...groups.values()]
        .filter((g) => g.writers.size >= minWriters)
        .sort((a, b) => compare(a.path, b.path) || compare(a.symbol, b.symbol));
    for (const { path, symbol, writers } of ordered) {
        const name = symbol || path.split("/").pop().replace(/\.[^.]+$/, "");
        const baseId = `contract-${slug(name)}`;
        let id = baseId;
        for (let n = 2; usedIds.has(id); n++)
            id = `${baseId}-${n}`;
        usedIds.add(id);
        const contract = { id, path, symbol, writers: [...writers.keys()] };
        contracts.push(contract);
        const target = symbol ? `\`${symbol}\` in ${path}` : path;
        const task = {
            id,
            kind: "contract",
            title: `Make ${target} extensible for ${writers.size} concurrent changes`,
            body: [
                "Writer tasks (waiting for this contract):",
                ...[...writers.values()].map((w) => `- ${w.id}: ${w.title}`),
                "",
                `Introduce exactly one extension point for ${target}: an options object parameter, a hooks map, or a registry, so that each of the listed changes can add to it additively without editing the others' lines.`,
                "Keep every existing call shape and all existing tests working. Add focused tests for the extension point.",
                "Do NOT implement the listed changes themselves. Keep the change as small as possible and land it quickly, others are waiting.",
            ].join("\n"),
            writes: [symbol ? { path, symbols: [symbol] } : { path }],
            reads: [],
            dependsOn: [],
        };
        const first = contract.writers[0];
        before.set(first, [...(before.get(first) ?? []), task]);
        for (const writer of contract.writers)
            dependencies.set(writer, [...(dependencies.get(writer) ?? []), contract]);
    }
    return {
        contracts,
        tasks: tasks.flatMap((task) => {
            const deps = dependencies.get(task.id);
            if (!deps)
                return [task];
            const paths = new Set(deps.map((c) => c.path));
            const reads = new Map();
            for (const read of task.reads ?? []) {
                const path = normalizePath(read.path);
                // A contract requires the whole file, even when an existing read names only a symbol.
                const scope = paths.has(path) ? { path } : read;
                const key = JSON.stringify([path, [...(scope.symbols ?? [])].sort(compare)]);
                if (!reads.has(key))
                    reads.set(key, scope);
            }
            for (const path of paths)
                reads.set(JSON.stringify([path, []]), { path });
            return [...(before.get(task.id) ?? []), {
                    ...task,
                    dependsOn: [...new Set([...(task.dependsOn ?? []), ...deps.map((c) => c.id)])],
                    reads: [...reads.values()],
                }];
        }),
    };
}
//# sourceMappingURL=contracts.js.map