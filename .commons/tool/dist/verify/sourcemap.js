// A minimal source map reader (version 3, `mappings` as base64 VLQ): enough to map a position in a bundle back to the
// source file and line it came from. No dependencies; sections (index maps) are not supported.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = new Map([...B64].map((c, i) => [c, i]));
/** Decode `mappings` into, per generated line, its segments sorted by generated column (segments without a source are dropped). */
export function decodeMappings(mappings) {
    const lines = [];
    let source = 0;
    let origLine = 0;
    let origCol = 0;
    for (const line of mappings.split(";")) {
        const out = [];
        let genCol = 0;
        if (line.length > 0) {
            for (const seg of line.split(",")) {
                if (seg.length === 0)
                    continue;
                const fields = [];
                let value = 0;
                let shift = 0;
                for (const c of seg) {
                    const digit = VALUE.get(c);
                    if (digit === undefined)
                        throw new Error(`invalid base64 VLQ character ${JSON.stringify(c)}`);
                    value += (digit & 31) << shift;
                    if (digit & 32)
                        shift += 5;
                    else {
                        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
                        value = 0;
                        shift = 0;
                    }
                }
                genCol += fields[0] ?? 0;
                if (fields.length >= 4) {
                    source += fields[1];
                    origLine += fields[2];
                    origCol += fields[3];
                    out.push([genCol, source, origLine, origCol]);
                }
            }
        }
        lines.push(out);
    }
    return lines;
}
/**
 * The original position of a generated one (0-based line and column): the last segment at or before the column on
 * that line, else the first segment after it on the same line. Null when the line has no mapped segment.
 */
export function originalPosition(lines, line, column) {
    const segs = lines[line];
    if (!segs || segs.length === 0)
        return null;
    let lo = 0;
    let hi = segs.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid][0] <= column) {
            found = mid;
            lo = mid + 1;
        }
        else
            hi = mid - 1;
    }
    const s = segs[found >= 0 ? found : 0];
    return { source: s[1], line: s[2], column: s[3] };
}
//# sourceMappingURL=sourcemap.js.map