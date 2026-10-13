const K1 = 1.2;
const B = 0.75;
const DEFAULT_MAX_WRITES = 3;
const DEFAULT_MAX_READS = 10;
const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with", "from", "into",
    "as", "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these", "those",
    "there", "then", "than", "so", "if", "not", "no", "do", "does", "did", "should", "would", "could", "can",
    "will", "may", "must", "we", "you", "they", "our", "your", "their", "when", "where", "which", "who",
    "what", "how", "all", "any", "each", "also", "via", "use", "used", "using", "add", "adds", "added",
    "make", "makes", "new", "support",
]);
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const CAMEL_PART = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
/** Split on `/ . - _` (any non-alphanumeric) and camelCase; lowercase; keep the whole segment too. */
function tokenize(text) {
    const out = [];
    for (const segment of text.split(/[^A-Za-z0-9]+/)) {
        if (!segment)
            continue;
        const lower = segment.toLowerCase();
        const parts = segment.match(CAMEL_PART) ?? [];
        if (parts.length > 1) {
            for (const part of parts)
                out.push(part.toLowerCase());
            out.push(lower);
        }
        else
            out.push(lower);
    }
    return out;
}
function count(tokens) {
    const counts = new Map();
    for (const token of tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
}
export function inferScopes(index, task, opts = {}) {
    const maxWrites = opts.maxWrites ?? DEFAULT_MAX_WRITES;
    const maxReads = opts.maxReads ?? DEFAULT_MAX_READS;
    if (index.files.length === 0)
        return { writes: [], reads: [] };
    // Documents: path tokens plus export-name tokens.
    const docs = index.files.map((file) => {
        const tokens = [...tokenize(file.path), ...file.exports.flatMap((e) => tokenize(e.name))];
        return { path: file.path, tf: count(tokens), length: tokens.length };
    });
    const n = docs.length;
    const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / n;
    const df = new Map();
    for (const doc of docs)
        for (const term of doc.tf.keys())
            df.set(term, (df.get(term) ?? 0) + 1);
    const idf = (term) => {
        const d = df.get(term) ?? 0;
        return Math.log(1 + (n - d + 0.5) / (d + 0.5));
    };
    // Query: task text tokenized the same way, minus stopwords.
    const text = `${task.title ?? ""}\n${task.body ?? ""}`;
    const query = count(tokenize(text).filter((t) => !STOPWORDS.has(t)));
    const scored = docs
        .map((doc) => {
        let score = 0;
        for (const [term, qtf] of query) {
            const tf = doc.tf.get(term) ?? 0;
            if (tf === 0)
                continue;
            const norm = tf + K1 * (1 - B + (B * doc.length) / avgLength);
            score += qtf * idf(term) * ((tf * (K1 + 1)) / norm);
        }
        return { path: doc.path, score };
    })
        .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const rank = new Map(scored.map((s, i) => [s.path, i]));
    // Writes: files exporting a symbol whose exact name appears in the task text (identifier match).
    const mentioned = new Set((text.match(IDENTIFIER) ?? []).filter((id) => id.length >= 2 && id !== "default" && !STOPWORDS.has(id.toLowerCase())));
    const withSymbols = [];
    for (const { path } of scored) {
        const file = index.byPath.get(path);
        if (!file)
            continue;
        const symbols = [...new Set(file.exports.map((e) => e.name).filter((name) => mentioned.has(name)))];
        if (symbols.length > 0)
            withSymbols.push({ path, symbols });
    }
    let writes;
    if (withSymbols.length > 0)
        writes = withSymbols.slice(0, maxWrites);
    else {
        const top = scored[0];
        writes = top && top.score > 0 ? [{ path: top.path }] : [];
    }
    const writePaths = new Set(writes.map((w) => w.path));
    // Reads: top scored files, then one-hop imports and importers of each write; deduped, no writes.
    const reads = [];
    const seen = new Set(writePaths);
    const addRead = (path) => {
        if (seen.has(path))
            return;
        seen.add(path);
        reads.push({ path });
    };
    for (const { path, score } of scored) {
        if (reads.length >= maxReads)
            break;
        if (score > 0)
            addRead(path);
    }
    const neighbors = [];
    for (const write of writes) {
        neighbors.push(...(index.byPath.get(write.path)?.imports ?? []), ...(index.importers.get(write.path) ?? []));
    }
    neighbors.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
    for (const path of neighbors)
        addRead(path);
    return { writes, reads };
}
//# sourceMappingURL=scope.js.map