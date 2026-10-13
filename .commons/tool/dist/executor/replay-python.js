// Python structural replay. Source slices preserve trivia; only module and class statement lists
// are replayed by identity. Function bodies use conservative line-wise diff3. Like the TS replay,
// this produces a candidate that the executor must still check, never a correctness verdict.
import { execFile } from "node:child_process";
export const PY_REPLAY_EXTENSIONS = /\.pyi?$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
let cachedAvailability;
/** Probe once per process with the working directory and user site excluded from Python's import path. */
export function pythonAvailable() {
    return (cachedAvailability ??= new Promise((resolve) => {
        execFile("python3", ["-I", "-c", "import ast, tokenize, difflib, json, hashlib"], { timeout: 10_000 }, (error) => resolve(!error));
    }));
}
/** Missing Python, resource limits, unsupported layouts, and parse failures fall through to other resolvers. */
export async function replayMergePython(path, base, main, mine, opts = {}) {
    if (!PY_REPLAY_EXTENSIONS.test(path) || [base, main, mine].some((s) => Buffer.byteLength(s, "utf8") > MAX_FILE_BYTES))
        return null;
    const timeout = opts.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeout) || timeout <= 0)
        return null;
    return new Promise((resolve) => {
        const child = execFile(opts.python ?? "python3", ["-I", "-c", PYTHON_REPLAY], { timeout, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
            if (error)
                return resolve(null);
            try {
                const result = JSON.parse(stdout);
                if (result === null)
                    return resolve(null);
                if (typeof result !== "object")
                    return resolve(null);
                const r = result;
                if (r.ok === true && typeof r.content === "string" && typeof r.replayed === "number")
                    resolve(r);
                else if (r.ok === false && Array.isArray(r.conflicts) && r.conflicts.every((c) => typeof c.at === "string" && typeof c.reason === "string"))
                    resolve(r);
                else
                    resolve(null);
            }
            catch {
                resolve(null);
            }
        });
        // A timed-out/failed child can close its input early. Its completion callback owns the result.
        child.stdin?.on("error", () => { });
        child.stdin?.end(JSON.stringify({ base, main, mine }));
    });
}
// No code from the repository is imported or executed. AST byte columns are converted to character
// offsets before slicing Unicode source; tokenize locates class headers and collection delimiters.
const PYTHON_REPLAY = String.raw `
import ast
import tokenize
import difflib
import json
import hashlib
import sys

class Unsupported(Exception):
    pass

class Conflict(Exception):
    def __init__(self, at, reason):
        self.at, self.reason = at, reason

def fail(at, reason):
    raise Conflict(at, reason)

def target_names(node):
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        names = [target_names(n) for n in node.elts]
        return sum(names, []) if all(names) else []
    return []

def key(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return "def:" + node.name
    if isinstance(node, ast.ClassDef):
        return "class:" + node.name
    if isinstance(node, ast.ImportFrom):
        return "from:" + "." * node.level + (node.module or "")
    if isinstance(node, ast.Import):
        return "import:" + node.names[0].name
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        names = [target_names(t) for t in targets]
        if all(names):
            return "assign:" + ",".join(sum(names, []))
    if isinstance(node, ast.If):
        t = node.test
        if (isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == "__name__"
                and len(t.ops) == 1 and isinstance(t.ops[0], ast.Eq)
                and len(t.comparators) == 1 and isinstance(t.comparators[0], ast.Constant)
                and t.comparators[0].value == "__main__"):
            return "if:__main__"
    # AST normalization ignores spacing/comments without conflating distinct string literals.
    return "stmt:" + hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest()

def first_line(node):
    return min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])

def physical_lines(text):
    # str.splitlines also splits Unicode separators inside valid Python string literals.
    parts = text.split("\n")
    return [p + "\n" for p in parts[:-1]] + ([parts[-1]] if parts[-1] else [])

class Source:
    def __init__(self, text):
        self.text = text
        self.tree = ast.parse(text)
        self.lines = physical_lines(text)
        self.offsets = [0]
        for line in self.lines:
            self.offsets.append(self.offsets[-1] + len(line))
        reader = iter(self.lines)
        self.tokens = list(tokenize.generate_tokens(lambda: next(reader, "")))
        self.newline = "\r\n" if "\r\n" in text else "\n"

    def pos(self, line, col, byte=False):
        if byte:
            col = len(self.lines[line - 1].encode("utf8")[:col].decode("utf8"))
        return self.offsets[line - 1] + col

    def start(self, node):
        return self.pos(node.lineno, node.col_offset, True)

    def end(self, node):
        return self.pos(node.end_lineno, node.end_col_offset, True)

    def class_end(self, node):
        end = node.end_lineno
        # Own trailing indented comments, but leave outer comments and blank separators for
        # the next element. AST end_lineno alone excludes these comments.
        for i in range(end, len(self.lines)):
            line = self.lines[i]
            if not line.strip():
                continue
            indent = len(line) - len(line.lstrip(" \t"))
            if line.lstrip().startswith("#") and indent > node.col_offset:
                end = i + 1
            else:
                break
        return self.offsets[end]

    def header_end(self, node):
        # A class can have a multiline signature or decorators; find the logical NEWLINE
        # after its class token. One-line suites stay leaves and merge line-wise.
        active = False
        for t in self.tokens:
            if t.start == (node.lineno, node.col_offset) and t.string == "class":
                active = True
            if active and t.type == tokenize.NEWLINE:
                return self.offsets[t.end[0]]
        raise Unsupported()

    def container(self, nodes, start, end):
        elems, cursor = [], start
        for node in nodes:
            lo = self.offsets[first_line(node) - 1]
            hi = self.class_end(node) if isinstance(node, ast.ClassDef) else self.offsets[node.end_lineno]
            if lo < cursor or hi > end:
                # Semicolon-separated statements share physical lines and have ambiguous trivia.
                raise Unsupported()
            elem = {"key": key(node), "lead": self.text[cursor:lo], "body": self.text[lo:hi],
                    "node": node, "source": self, "lo": lo, "nested": None}
            if isinstance(node, ast.ClassDef) and first_line(node.body[0]) > node.lineno:
                header = self.header_end(node)
                if header <= self.offsets[first_line(node.body[0]) - 1]:
                    elem["header"] = self.text[lo:header]
                    elem["nested"] = self.container(node.body, header, hi)
            elems.append(elem)
            cursor = hi
        # A stable final element keeps trailing comments after newly inserted statements.
        elems.append({"key": "trivia", "lead": "", "body": self.text[cursor:end], "nested": None})
        return {"elems": elems, "newline": self.newline}

def line_merge(base, main, mine, at):
    if main == mine or mine == base:
        return main
    if main == base:
        return mine
    lines = physical_lines(base)
    def changes(text):
        other = physical_lines(text)
        return [(i, j, other[k:l]) for op, i, j, k, l in
                difflib.SequenceMatcher(None, lines, other, autojunk=False).get_opcodes() if op != "equal"]
    ours, theirs = changes(main), changes(mine)
    for a in ours:
        for b in theirs:
            if a == b:
                continue
            i, j, _ = a
            k, l, _ = b
            overlap = (i == j == k == l or (i == j and k <= i < l)
                       or (k == l and i <= k < j) or max(i, k) < min(j, l))
            if overlap:
                fail(at, "both sides modified the same lines")
    edits = ours + [b for b in theirs if b not in ours]
    out, cursor = [], 0
    for i, j, replacement in sorted(edits, key=lambda e: (e[0], e[1])):
        out.extend(lines[cursor:i])
        out.extend(replacement)
        cursor = j
    out.extend(lines[cursor:])
    return "".join(out)

def aliases(elem):
    return [(n.name, n.asname) for n in elem["node"].names]

def only_additions(base, main, mine, at):
    for side in (main, mine):
        if [n for n in side if n in base] != base:
            fail(at, "removed or reordered collection entries")
    return base + [n for n in main if n not in base] + [n for n in mine if n not in base and n not in main]

def comments(elem):
    if elem is None:
        return set()
    s, lo = elem["source"], elem["lo"]
    return {t.string for t in s.tokens if t.type == tokenize.COMMENT
            and lo <= s.pos(*t.start) < lo + len(elem["body"])}

def check_collection_comments(base, main, mine, at):
    # The renderer retains main's comment slices. Refuse a concurrent comment edit it cannot
    # represent, rather than silently losing submission comments while unioning names.
    if comments(mine) - comments(base) - comments(main) or (comments(base) - comments(mine)) & comments(main):
        fail(at, "collection comment edits cannot be preserved")

def render_additions(elem, nodes, additions, close_char=None):
    if not additions:
        return elem["body"]
    source, lo, body = elem["source"], elem["lo"], elem["body"]
    last_end = source.end(nodes[-1]) - lo
    # Retain main's spelling, inline comments, parentheses, and trailing comma. Add rows
    # before its closing delimiter when that delimiter is on its own line.
    close = None
    if close_char:
        for t in source.tokens:
            pos = source.pos(*t.start) - lo
            if last_end <= pos < len(body) and t.type == tokenize.OP and t.string == close_char:
                close = pos
                break
    if close is not None and "\n" in body[:close]:
        line_start = body.rfind("\n", 0, close) + 1
        if not body[line_start:close].strip():
            first = nodes[0]
            prefix = source.lines[first.lineno - 1][:len(source.lines[first.lineno - 1]) - len(source.lines[first.lineno - 1].lstrip(" \t"))]
            if source.start(first) == source.pos(first.lineno, len(prefix)):
                indent = prefix
            else:
                indent = body[:len(body) - len(body.lstrip(" \t"))] + "    "
            rows = "".join(indent + name + "," + source.newline for name in additions)
            comma = "" if body[last_end:close].lstrip().startswith(",") else ","
            return body[:last_end] + comma + body[last_end:line_start] + rows + body[line_start:]
    return body[:last_end] + ", " + ", ".join(additions) + body[last_end:]

def render_union(elem, nodes, current, names, spelling, close_char, at):
    if names[:len(current)] == current:
        return render_additions(elem, nodes, [spelling(n) for n in names[len(current):]], close_char)
    s, lo, body = elem["source"], elem["lo"], elem["body"]
    starts, ends = [s.start(n) - lo for n in nodes], [s.end(n) - lo for n in nodes]
    close = next((s.pos(*t.start) - lo for t in s.tokens if t.type == tokenize.OP and t.string == close_char
                  and ends[-1] <= s.pos(*t.start) - lo < len(body)), None)
    # Moving a name added between base names is required by base/main/mine union order.
    # Move its whole row, including inline comments, when main uses one item per line.
    line_starts = [body.rfind("\n", 0, p) + 1 for p in starts]
    closing_line = body.rfind("\n", 0, close) + 1 if close is not None else None
    if (closing_line is not None and closing_line > line_starts[-1]
            and not body[closing_line:close].strip()
            and all(not body[a:b].strip() for a, b in zip(line_starts, starts))):
        records = {}
        for i, name in enumerate(current):
            after = line_starts[i + 1] if i + 1 < len(nodes) else closing_line
            tail = body[ends[i]:after]
            comma = "" if tail.lstrip().startswith(",") else ","
            records[name] = body[starts[i]:ends[i]] + comma + tail
        indent = body[line_starts[0]:starts[0]]
        rows = [indent + records[n] if n in records else indent + spelling(n) + "," + s.newline for n in names]
        return body[:line_starts[0]] + "".join(rows) + body[closing_line:]
    if comments(elem):
        fail(at, "cannot move inline collection entries without moving comments")
    spellings = {name: body[a:b] for name, a, b in zip(current, starts, ends)}
    return body[:starts[0]] + ", ".join(spellings[n] if n in spellings else spelling(n) for n in names) + body[ends[-1]:]

def merge_import(base, main, mine, at):
    bn = aliases(base) if base else []
    mn, nn = aliases(main), aliases(mine)
    names = only_additions(bn, mn, nn, at)
    if any(n[0] == "*" for n in names) and len(names) > 1:
        fail(at, "wildcard and named imports differ")
    bound = {}
    for name, alias in names:
        binding = alias or (name.split(".")[0] if isinstance(main["node"], ast.Import) else name)
        if binding in bound and bound[binding] != (name, alias):
            fail(at, "imports bind the same name differently")
        bound[binding] = (name, alias)
    check_collection_comments(base, main, mine, at)
    def spelling(pair):
        name, alias = pair
        return name + (" as " + alias if alias else "")
    return render_union(main, main["node"].names, mn, names, spelling,
                        ")" if isinstance(main["node"], ast.ImportFrom) else None, at)

def all_entries(elem):
    node = elem.get("node")
    if not isinstance(node, (ast.Assign, ast.AnnAssign)) or elem["key"] != "assign:__all__":
        return None
    value = node.value
    if not isinstance(value, ast.List) or not all(isinstance(n, ast.Constant) and isinstance(n.value, str) for n in value.elts):
        return None
    return [n.value for n in value.elts]

def merge_all(base, main, mine, at):
    b, m, n = [all_entries(e) for e in (base, main, mine)]
    if b is None or m is None or n is None:
        return None
    if any(len(s) != len(set(s)) for s in (b, m, n)):
        fail(at, "duplicate __all__ entries")
    names = only_additions(b, m, n, at)
    # The list is the only part regenerated. Concurrent edits to the annotation/target conflict.
    src, node = main["source"], main["node"]
    def outside(e):
        s, v = e["source"], e["node"].value
        return e["body"][:s.start(v) - e["lo"]] + "[]" + e["body"][s.end(v) - e["lo"]:]
    shell = line_merge(outside(base), outside(main), outside(mine), at)
    if shell != outside(main):
        return None  # Fall back to whole-element line-wise merging for a changed shell.
    first = node.value.elts[0] if node.value.elts else None
    if first is None:
        return None
    quote = src.text[src.start(first)]
    def spelling(name):
        encoded = json.dumps(name, ensure_ascii=False)
        if quote == "'":
            return "'" + encoded[1:-1].replace('\\"', '"').replace("'", "\\'") + "'"
        return encoded
    check_collection_comments(base, main, mine, at)
    return render_union(main, node.value.elts, m, names, spelling, "]", at)

def merge_element(base, main, mine, at, ctx):
    lead = line_merge(base["lead"], main["lead"], mine["lead"], at + "/lead")
    b, m, n = [e["body"] for e in (base, main, mine)]
    if m == n or n == b:
        body = m
    elif m == b:
        body = n
    elif main["key"].startswith(("from:", "import:")):
        body = merge_import(base, main, mine, at)
    elif all(e["nested"] is not None for e in (base, main, mine)):
        header = line_merge(base["header"], main["header"], mine["header"], at + "/header")
        body = header + merge_container(base["nested"], main["nested"], mine["nested"], at, ctx)
    else:
        body = merge_all(base, main, mine, at) if base["key"] == "assign:__all__" else None
        if body is None:
            body = line_merge(b, m, n, at)
    if body != m or lead != main["lead"]:
        ctx["replayed"] += 1
    return {**main, "lead": lead, "body": body}

def index(container, at):
    out = {}
    for e in container["elems"]:
        if e["key"] in out:
            fail(at + "/" + e["key"], "ambiguous duplicate element identity")
        out[e["key"]] = e
    return out

def validate_order(base, main, mine, at):
    bi, mi, ni = [index(c, at) for c in (base, main, mine)]
    for side in (mi, ni):
        if [k for k in side if k in bi] != [k for k in bi if k in side]:
            fail(at, "reordering existing elements is unsupported")
    # Check nested classes even when only one side changed (before scalar shortcuts).
    for k, b in bi.items():
        m, n = mi.get(k), ni.get(k)
        if m and n and all(e["nested"] is not None for e in (b, m, n)):
            validate_order(b["nested"], m["nested"], n["nested"], at + "/" + k)
    return bi, mi, ni

def insertions(container, base):
    out, anchor = {}, ""
    for e in container["elems"]:
        if e["key"] in base:
            anchor = e["key"]
        else:
            out.setdefault(anchor, []).append(e)
    return out

def bindings(elem):
    node = elem.get("node")
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        return sum([target_names(t) for t in targets], [])
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return [n.asname or (n.name.split(".")[0] if isinstance(node, ast.Import) else n.name) for n in node.names]
    return []

def merge_container(base, main, mine, at, ctx):
    bi, mi, ni = validate_order(base, main, mine, at)
    ours, theirs = insertions(main, bi), insertions(mine, bi)
    # Inserting before a statement can transfer its original lead (for example a file
    # header) onto each side's new first element. Replay that shared trivia only once.
    anchors = [""] + list(bi)
    for anchor, following in zip(anchors, bi):
        a, b = ours.get(anchor, []), theirs.get(anchor, [])
        original = bi[following]["lead"]
        m, n = mi.get(following), ni.get(following)
        if (a and b and a[0]["key"] != b[0]["key"] and original and original.strip() and m and n
                and a[0]["lead"].startswith(original) and b[0]["lead"].startswith(original)
                and not m["lead"].startswith(original) and not n["lead"].startswith(original)):
            b[0] = {**b[0], "lead": n["lead"] + b[0]["lead"][len(original):]}
    main_slots = {e["key"]: anchor for anchor, group in ours.items() for e in group}
    main_bindings = {name: e["key"] for group in ours.values() for e in group for name in bindings(e)}
    for anchor, group in theirs.items():
        for e in group:
            k = e["key"]
            if k in main_slots and main_slots[k] != anchor:
                fail(at + "/" + k, "same insertion has different anchors")
            if any(name in main_bindings and main_bindings[name] != k for name in bindings(e)):
                fail(at + "/" + k, "insertions bind the same name differently")
    out = []
    def gap(anchor):
        out.extend(ours.get(anchor, []))
        for e in theirs.get(anchor, []):
            k, other = e["key"], mi.get(e["key"])
            if other is None:
                out.append(e)
                ctx["replayed"] += 1
            elif other["body"] == e["body"]:
                # Collapse identical code, combining independent leading comments if possible.
                lead = line_merge("", other["lead"], e["lead"], at + "/" + k + "/lead")
                out[out.index(other)] = {**other, "lead": lead}
            elif k.startswith(("from:", "import:")):
                lead = line_merge("", other["lead"], e["lead"], at + "/" + k + "/lead")
                body = merge_import(None, other, e, at + "/" + k)
                out[out.index(other)] = {**other, "lead": lead, "body": body}
                ctx["replayed"] += 1
            else:
                fail(at + "/" + k, "both sides inserted the same name with different content")
    gap("")
    for k, b in bi.items():
        m, n = mi.get(k), ni.get(k)
        here = at + "/" + k
        if m is None or n is None:
            surviving = m if m is not None else n
            if surviving is not None and (surviving["body"] != b["body"] or surviving["lead"] != b["lead"]):
                fail(here, "deleted on one side but modified on the other")
            if m is not None and n is None:
                ctx["replayed"] += 1
        else:
            out.append(merge_element(b, m, n, here, ctx))
        gap(k)
    text = ""
    for e in out:
        chunk = e["lead"] + e["body"]
        if text and chunk and not text.endswith(("\n", "\r")) and not chunk.startswith(("\n", "\r")):
            text += main["newline"]
        text += chunk
    return text

def run(data):
    try:
        sources = [Source(data[k]) for k in ("base", "main", "mine")]
        containers = [s.container(s.tree.body, 0, len(s.text)) for s in sources]
        ctx = {"replayed": 0}
        content = merge_container(*containers, "", ctx)
        try:
            ast.parse(content)
        except SyntaxError:
            fail("", "merged file does not parse")
        return {"ok": True, "content": content, "replayed": ctx["replayed"]}
    except Conflict as e:
        return {"ok": False, "conflicts": [{"at": e.at, "reason": e.reason}]}
    except (SyntaxError, Unsupported, tokenize.TokenError, RecursionError, ValueError):
        return None

print(json.dumps(run(json.loads(sys.stdin.buffer.read().decode("utf8"))), ensure_ascii=True))
`;
//# sourceMappingURL=replay-python.js.map