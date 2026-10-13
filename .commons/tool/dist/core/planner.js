/** Two scopes intersect when they name the same path and either side is file-level
 *  (no symbols / empty symbols) or they share at least one symbol. */
export function scopesIntersect(a, b) {
    for (const x of a) {
        for (const y of b) {
            if (x.path !== y.path)
                continue;
            const xs = x.symbols;
            const ys = y.symbols;
            if (!xs || xs.length === 0 || !ys || ys.length === 0)
                return true;
            if (xs.some((s) => ys.includes(s)))
                return true;
        }
    }
    return false;
}
/**
 * producers(t) = tasks whose writes intersect t.reads, plus t.dependsOn (known ids only).
 * rank: Kahn's algorithm processed in waves (every ready task of a wave ranks before any task
 *       that becomes ready afterwards); ties inside a wave by `order`, then input position.
 *       A cycle is broken by dropping the cycle edge leaving the producer with the fewest
 *       transitive consumers (ties by `order`).
 * batch: greedy coloring in rank order over the conflict relation; a consumer always lands in a
 *       batch above all of its producers. Conflict = producer edge in "dependencies" and
 *       "overlaps"/"pipeline" modes, plus writes∩writes in "overlaps" and "pipeline"; nothing in "none".
 *       ("pipeline" differs from "overlaps" only in when a blocker releases: on submit instead of on landing.)
 * blockedBy: conflicting tasks in lower batches, ordered by rank.
 */
export function plan(tasks, admission) {
    const nodes = tasks
        .map((t, idx) => ({ ...t, idx }))
        .sort((a, b) => a.order - b.order || a.idx - b.idx);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pos = new Map(nodes.map((n, i) => [n.id, i]));
    const cmp = (a, b) => pos.get(a) - pos.get(b);
    const producers = new Map();
    const consumers = new Map();
    for (const n of nodes) {
        producers.set(n.id, new Set());
        consumers.set(n.id, new Set());
    }
    const addEdge = (p, c) => {
        producers.get(c).add(p);
        consumers.get(p).add(c);
    };
    for (const c of nodes) {
        if (admission !== "declared") {
            for (const p of nodes) {
                if (p.id !== c.id && scopesIntersect(p.writes, c.reads))
                    addEdge(p.id, c.id);
            }
        }
        for (const dep of c.dependsOn) {
            if (dep !== c.id && byId.has(dep))
                addEdge(dep, c.id);
        }
    }
    // Kahn in waves with cycle breaking.
    const remaining = new Set(nodes.map((n) => n.id));
    const indeg = new Map(nodes.map((n) => [n.id, producers.get(n.id).size]));
    const rank = new Map();
    const ranked = [];
    const removeEdge = (p, c) => {
        if (!producers.get(c).delete(p))
            return;
        consumers.get(p).delete(c);
        if (remaining.has(p) && remaining.has(c))
            indeg.set(c, indeg.get(c) - 1);
    };
    const transitiveConsumers = (id) => {
        const seen = new Set();
        const stack = [id];
        while (stack.length) {
            const cur = stack.pop();
            for (const c of consumers.get(cur)) {
                if (!seen.has(c)) {
                    seen.add(c);
                    stack.push(c);
                }
            }
        }
        seen.delete(id);
        return seen.size;
    };
    const findCycle = () => {
        const state = new Map();
        const stack = [];
        const visit = (n) => {
            state.set(n, 1);
            stack.push(n);
            const next = [...consumers.get(n)].filter((x) => remaining.has(x)).sort(cmp);
            for (const c of next) {
                const s = state.get(c);
                if (s === 1)
                    return stack.slice(stack.indexOf(c));
                if (s === undefined) {
                    const found = visit(c);
                    if (found)
                        return found;
                }
            }
            stack.pop();
            state.set(n, 2);
            return null;
        };
        for (const n of [...remaining].sort(cmp)) {
            if (!state.has(n)) {
                const found = visit(n);
                if (found)
                    return found;
            }
        }
        return null;
    };
    const breakCycle = () => {
        const cycle = findCycle();
        if (!cycle) {
            // Defensive: cannot happen when every remaining node has a remaining producer.
            const id = [...remaining].sort(cmp)[0];
            for (const p of [...producers.get(id)])
                if (remaining.has(p))
                    removeEdge(p, id);
            return;
        }
        let best = 0;
        let bestCount = Infinity;
        for (let i = 0; i < cycle.length; i++) {
            const n = transitiveConsumers(cycle[i]);
            if (n < bestCount || (n === bestCount && cmp(cycle[i], cycle[best]) < 0)) {
                best = i;
                bestCount = n;
            }
        }
        removeEdge(cycle[best], cycle[(best + 1) % cycle.length]);
    };
    while (remaining.size > 0) {
        const ready = [...remaining].filter((id) => indeg.get(id) === 0).sort(cmp);
        if (ready.length === 0) {
            breakCycle();
            continue;
        }
        for (const id of ready) {
            rank.set(id, ranked.length);
            ranked.push(id);
            remaining.delete(id);
        }
        for (const id of ready) {
            for (const c of consumers.get(id))
                if (remaining.has(c))
                    indeg.set(c, indeg.get(c) - 1);
        }
    }
    // Greedy batch coloring in rank order.
    const conflicts = (a, b) => {
        if (admission === "none")
            return false;
        if (producers.get(a).has(b) || producers.get(b).has(a))
            return true;
        if (admission === "overlaps" || admission === "pipeline")
            return scopesIntersect(byId.get(a).writes, byId.get(b).writes);
        return false;
    };
    const batch = new Map();
    for (const id of ranked) {
        let b = 0;
        if (admission !== "none") {
            for (const p of producers.get(id))
                b = Math.max(b, (batch.get(p) ?? -1) + 1);
            const taken = new Set();
            for (const other of ranked) {
                if (other === id)
                    break;
                if (conflicts(id, other))
                    taken.add(batch.get(other));
            }
            while (taken.has(b))
                b++;
        }
        batch.set(id, b);
    }
    const byRank = (a, b) => rank.get(a) - rank.get(b);
    return ranked.map((id) => ({
        id,
        rank: rank.get(id),
        batch: batch.get(id),
        blockedBy: ranked.filter((o) => o !== id && batch.get(o) < batch.get(id) && conflicts(id, o)),
        producers: [...producers.get(id)].sort(byRank),
    }));
}
//# sourceMappingURL=planner.js.map