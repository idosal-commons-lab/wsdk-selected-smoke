// Structural replay: a keyed, element-level three-way merge for TypeScript and JavaScript files.
//
// A file is read as a tree of containers (statement lists, member lists, object properties, array elements,
// switch clauses) whose elements carry an identity instead of a line number: a declared name, an imported
// module, a member name, a test title, or a hash of the content. Each side's edits are read as element
// operations against the base (insert after an anchor, delete, modify) and replayed onto the other side:
//
//   - insertions into the same list commute (main's first, then the submission's);
//   - identical insertions collapse to one, imports and re-exports of one module merge their specifiers;
//   - an element both sides changed is merged through its nested lists, then line-wise, and only then
//     reported as a conflict;
//   - two insertions that bind the same name are a conflict even when the text would merge, and a deletion
//     on one side against a modification on the other is a conflict.
//
// The result is a candidate, not a verdict: the executor still runs the checks on the combined tree.
import ts from "typescript";
/** Files the replay merge understands: .ts .tsx .js .jsx .mts .cts .mjs .cjs. */
export const REPLAY_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CELLS = 4_000_000;
/**
 * Merge `mine` (a submission's version of the file) onto `main` (the current candidate) through their common
 * `base`. Returns null when the file type is unsupported or any side does not parse, so the caller can fall
 * back to another resolver.
 */
export function replayMerge(path, base, main, mine) {
    if (!REPLAY_EXTENSIONS.test(path))
        return null;
    if (base.length > MAX_FILE_BYTES || main.length > MAX_FILE_BYTES || mine.length > MAX_FILE_BYTES)
        return null;
    const sb = parse(path, base);
    const sm = parse(path, main);
    const sn = parse(path, mine);
    if (!sb || !sm || !sn)
        return null;
    const ctx = { conflicts: [], replayed: 0 };
    const merged = merge3(rootOf(sb, base), rootOf(sm, main), rootOf(sn, mine), "", ctx);
    if (ctx.conflicts.length > 0)
        return { ok: false, conflicts: ctx.conflicts };
    const content = serialize(merged);
    if (!parse(path, content))
        return { ok: false, conflicts: [{ at: "", reason: "merged file does not parse" }] };
    return { ok: true, content, replayed: ctx.replayed };
}
// ---------------------------------------------------------------------------------------------
// Parsing into containers
function parse(path, src) {
    const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, scriptKindFor(path));
    const diagnostics = sf.parseDiagnostics ?? [];
    return diagnostics.length === 0 ? sf : null;
}
function scriptKindFor(path) {
    if (path.endsWith(".tsx"))
        return ts.ScriptKind.TSX;
    if (path.endsWith(".jsx"))
        return ts.ScriptKind.JSX;
    if (/\.[cm]?js$/.test(path))
        return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
}
function rootOf(sf, src) {
    return containerOf(src, { arr: sf.statements, close: src.length, comma: false, keyer: stmtKey });
}
function containerOf(src, list) {
    const { arr, close, comma, keyer } = list;
    const counts = new Map();
    const elems = [];
    for (let i = 0; i < arr.length; i++) {
        const node = arr[i];
        const start = node.getStart();
        const lead = src.slice(node.pos, start);
        const body = src.slice(start, node.end);
        const sepEnd = i + 1 < arr.length ? arr[i + 1].pos : arr.end;
        const sep = comma || list.sep ? src.slice(node.end, sepEnd) : "";
        const k = keyer(node);
        const n = (counts.get(k.key) ?? 0) + 1;
        counts.set(k.key, n);
        const binding = bindingOf(node, src);
        elems.push({
            key: n === 1 ? k.key : `${k.key}#${n}`,
            identity: k.identity,
            lead,
            body,
            sep,
            norm: body.trim(),
            parts: partsOf(src, node, start),
            ...(binding ? { binding } : {}),
        });
    }
    const last = elems[elems.length - 1];
    return { comma, fuse: list.fuse === true, elems, closing: src.slice(arr.end, close), trailing: comma && last !== undefined && last.sep.includes(","), ...(list.sep ? { sep: list.sep } : {}) };
}
/** An element's body as literal slices around its nested lists (a leaf is a single slice). */
function partsOf(src, node, start) {
    const subs = subListsOf(node)
        .filter((s) => s.arr.pos >= start && s.close <= node.end && s.arr.end <= s.close)
        .sort((a, b) => a.arr.pos - b.arr.pos);
    if (subs.length === 0)
        return [src.slice(start, node.end)];
    const parts = [];
    let cursor = start;
    for (const s of subs) {
        if (s.arr.pos < cursor)
            return [src.slice(start, node.end)];
        parts.push(src.slice(cursor, s.arr.pos));
        parts.push(containerOf(src, s));
        cursor = s.close;
    }
    parts.push(src.slice(cursor, node.end));
    return parts;
}
function statementsOf(block) {
    return { arr: block.statements, close: block.end - 1, comma: false, keyer: stmtKey };
}
/** A signature's parameter list between its parentheses; null for an arrow with an unparenthesized parameter or an index signature. */
function paramsOf(node) {
    const sf = node.getSourceFile();
    const children = node.getChildren(sf);
    const open = children.findIndex((c) => c.kind === ts.SyntaxKind.OpenParenToken);
    if (open < 0)
        return null;
    const next = children[open + 1];
    const closeTok = next?.kind === ts.SyntaxKind.SyntaxList ? children[open + 2] : next;
    if (!closeTok || closeTok.kind !== ts.SyntaxKind.CloseParenToken)
        return null;
    return { arr: node.parameters, close: closeTok.getStart(sf), comma: true, keyer: paramKey, fuse: true };
}
/** A lone object type uses the same outer list as a union/intersection containing it. */
function typeListsOf(node) {
    if (!node)
        return [];
    if (ts.isTypeLiteralNode(node))
        return [singletonOf(node, typeKey, "type")];
    return subListsOf(node);
}
function singletonOf(node, keyer, sep) {
    const arr = ts.setTextRange(ts.factory.createNodeArray([node]), node);
    return { arr, close: node.end, comma: false, keyer, fuse: true, ...(sep ? { sep } : {}) };
}
/** The nested lists of a node, in source order: function bodies, member lists, object and array literals. */
function subListsOf(node) {
    if (!node)
        return [];
    if (ts.isBlock(node) || ts.isModuleBlock(node))
        return [statementsOf(node)];
    if (ts.isFunctionLike(node)) {
        const params = paramsOf(node);
        const body = node.body;
        const after = body ? (ts.isBlock(body) ? [statementsOf(body)] : subListsOf(body)) : typeListsOf(node.type);
        return [...(params ? [params] : []), ...after];
    }
    if (ts.isParameter(node))
        return [...typeListsOf(node.type), ...subListsOf(node.initializer)];
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
        return [{ arr: node.types, close: node.end, comma: false, sep: ts.isUnionTypeNode(node) ? "|" : "&", keyer: typeKey, fuse: true }];
    }
    if (ts.isObjectLiteralExpression(node))
        return [{ arr: node.properties, close: node.end - 1, comma: true, keyer: propKey, fuse: true }];
    if (ts.isArrayLiteralExpression(node))
        return [{ arr: node.elements, close: node.end - 1, comma: true, keyer: contentKey }];
    if (ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isAwaitExpression(node) ||
        ts.isTypeAssertionExpression(node)) {
        return subListsOf(node.expression);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const args = node.arguments;
        return args && args.length > 0 ? subListsOf(args[args.length - 1]) : [];
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
        return [{ arr: node.members, close: node.end - 1, comma: false, keyer: memberKey, fuse: true }];
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
        return [{ arr: node.members, close: node.end - 1, comma: false, keyer: memberKey }];
    if (ts.isEnumDeclaration(node))
        return [{ arr: node.members, close: node.end - 1, comma: true, keyer: enumKey }];
    if (ts.isModuleDeclaration(node))
        return subListsOf(node.body);
    if (ts.isVariableStatement(node)) {
        const decls = node.declarationList.declarations;
        return decls.length === 1 ? subListsOf(decls[0].initializer) : [];
    }
    if (ts.isVariableDeclaration(node))
        return subListsOf(node.initializer);
    if (ts.isExpressionStatement(node) || ts.isReturnStatement(node) || ts.isThrowStatement(node) || ts.isExportAssignment(node)) {
        return subListsOf(node.expression);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        return subListsOf(node.right);
    if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node))
        return subListsOf(node.initializer);
    if (ts.isPropertySignature(node) || ts.isTypeAliasDeclaration(node))
        return typeListsOf(node.type);
    if (ts.isIfStatement(node)) {
        const otherwise = node.elseStatement;
        return [...subListsOf(node.thenStatement), ...(otherwise && ts.isIfStatement(otherwise) ? [singletonOf(otherwise, stmtKey)] : subListsOf(otherwise))];
    }
    if (ts.isTryStatement(node)) {
        return [...subListsOf(node.tryBlock), ...subListsOf(node.catchClause?.block), ...subListsOf(node.finallyBlock)];
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
        return subListsOf(node.statement);
    }
    if (ts.isLabeledStatement(node))
        return subListsOf(node.statement);
    if (ts.isSwitchStatement(node))
        return [{ arr: node.caseBlock.clauses, close: node.caseBlock.end - 1, comma: false, keyer: caseKey }];
    if (ts.isCaseClause(node) || ts.isDefaultClause(node))
        return [{ arr: node.statements, close: node.end, comma: false, keyer: stmtKey }];
    return [];
}
// ---------------------------------------------------------------------------------------------
// Element identity
const id = (key) => ({ key, identity: true });
const anon = (key) => ({ key, identity: false });
function hash(text) {
    const s = text.replace(/\s+/g, " ").trim();
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = (h * 33) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
}
function moduleOf(spec) {
    return spec && ts.isStringLiteralLike(spec) ? spec.text : "";
}
function stmtKey(node) {
    if (ts.isImportDeclaration(node)) {
        return id(`import:${moduleOf(node.moduleSpecifier)}${node.importClause?.isTypeOnly ? ":type" : ""}`);
    }
    if (ts.isImportEqualsDeclaration(node))
        return id(`import=:${node.name.text}`);
    if (ts.isExportDeclaration(node)) {
        const type = node.isTypeOnly ? ":type" : "";
        return id(node.moduleSpecifier ? `export-from:${moduleOf(node.moduleSpecifier)}${type}` : `export-local${type}`);
    }
    if (ts.isExportAssignment(node))
        return id(node.isExportEquals ? "export=" : "export-default");
    if (ts.isFunctionDeclaration(node))
        return id(`function:${node.name?.text ?? "default"}`);
    if (ts.isClassDeclaration(node))
        return id(`class:${node.name?.text ?? "default"}`);
    if (ts.isInterfaceDeclaration(node))
        return id(`interface:${node.name.text}`);
    if (ts.isTypeAliasDeclaration(node))
        return id(`type:${node.name.text}`);
    if (ts.isEnumDeclaration(node))
        return id(`enum:${node.name.text}`);
    if (ts.isModuleDeclaration(node))
        return id(`module:${node.name.text}`);
    if (ts.isVariableStatement(node)) {
        return id(`var:${node.declarationList.declarations.map((d) => d.name.getText()).join(",")}`);
    }
    if (ts.isExpressionStatement(node)) {
        const e = node.expression;
        if (ts.isCallExpression(e)) {
            const first = e.arguments[0];
            const title = first && ts.isStringLiteralLike(first) ? JSON.stringify(first.text) : hash(e.getText());
            return anon(`call:${e.expression.getText()}:${title}`);
        }
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken)
            return anon(`assign:${e.left.getText()}`);
        return anon(`expr:${hash(e.getText())}`);
    }
    if (ts.isReturnStatement(node))
        return anon("return");
    if (ts.isIfStatement(node))
        return anon(`if:${hash(node.expression.getText())}`);
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node)) {
        return anon(`loop:${hash(node.getText().slice(0, node.statement.getStart() - node.getStart()))}`);
    }
    if (ts.isDoStatement(node))
        return anon(`do:${hash(node.expression.getText())}`);
    if (ts.isSwitchStatement(node))
        return anon(`switch:${hash(node.expression.getText())}`);
    if (ts.isTryStatement(node))
        return anon("try");
    if (ts.isThrowStatement(node))
        return anon(`throw:${hash(node.expression.getText())}`);
    return anon(`${ts.SyntaxKind[node.kind]}:${hash(node.getText())}`);
}
/**
 * The part of a content-hashed key that survives a rewrite of the element: the callee of a call statement,
 * the kind of a control-flow statement. Two elements of one family in one slot are a rewrite, not an
 * insertion beside a deletion. Null for keys that carry no such family.
 */
function familyOf(key) {
    const bare = key.replace(/#\d+$/, "");
    if (bare.startsWith("call:"))
        return bare.slice(0, bare.lastIndexOf(":"));
    const m = /^(if|loop|do|switch|throw):/.exec(bare);
    return m ? m[1] : null;
}
function nameText(node) {
    return node.name ? node.name.getText() : "";
}
function memberKey(node) {
    const isStatic = ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    const prefix = isStatic ? "static " : "";
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
        return id(`${prefix}prop:${nameText(node)}`);
    if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node))
        return id(`${prefix}method:${nameText(node)}`);
    if (ts.isGetAccessor(node))
        return id(`${prefix}get:${nameText(node)}`);
    if (ts.isSetAccessor(node))
        return id(`${prefix}set:${nameText(node)}`);
    if (ts.isConstructorDeclaration(node))
        return id("constructor");
    if (ts.isIndexSignatureDeclaration(node))
        return anon("index");
    if (ts.isCallSignatureDeclaration(node))
        return anon("call");
    if (ts.isConstructSignatureDeclaration(node))
        return anon("new");
    if (ts.isClassStaticBlockDeclaration(node))
        return anon("static-block");
    return anon(`${ts.SyntaxKind[node.kind]}:${hash(node.getText())}`);
}
function paramKey(node) {
    if (ts.isParameter(node))
        return ts.isIdentifier(node.name) ? id(`param:${node.name.text}`) : anon(`param:${hash(node.name.getText())}`);
    return anon(`${ts.SyntaxKind[node.kind]}:${hash(node.getText())}`);
}
function propKey(node) {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node))
        return id(nameText(node));
    if (ts.isGetAccessor(node))
        return id(`get:${nameText(node)}`);
    if (ts.isSetAccessor(node))
        return id(`set:${nameText(node)}`);
    if (ts.isSpreadAssignment(node))
        return anon(`spread:${hash(node.expression.getText())}`);
    return anon(`${ts.SyntaxKind[node.kind]}:${hash(node.getText())}`);
}
function enumKey(node) {
    return ts.isEnumMember(node) ? id(nameText(node)) : anon(hash(node.getText()));
}
function contentKey(node) {
    return anon(hash(node.getText()));
}
function typeKey(node) {
    return ts.isTypeLiteralNode(node) ? id("type-literal") : contentKey(node);
}
function caseKey(node) {
    return ts.isCaseClause(node) ? anon(`case:${hash(node.expression.getText())}`) : anon("default");
}
// ---------------------------------------------------------------------------------------------
// Imports and re-exports merge as specifier sets
function bindingOf(node, src) {
    const semi = src.slice(node.end - 1, node.end) === ";";
    if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (!clause || !ts.isStringLiteralLike(node.moduleSpecifier))
            return undefined;
        const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.map((e) => e.getText()) : [];
        const ns = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text : undefined;
        return {
            kind: "import",
            module: node.moduleSpecifier.text,
            typeOnly: clause.isTypeOnly,
            ...(clause.name ? { def: clause.name.text } : {}),
            ...(ns ? { ns } : {}),
            named,
            quote: node.moduleSpecifier.getText()[0] ?? '"',
            semi,
        };
    }
    if (ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (spec && !ts.isStringLiteralLike(spec))
            return undefined;
        const clause = node.exportClause;
        if (!spec && !clause)
            return undefined;
        const named = clause && ts.isNamedExports(clause) ? clause.elements.map((e) => e.getText()) : [];
        const ns = clause && ts.isNamespaceExport(clause) ? clause.name.text : !clause ? "*" : undefined;
        return {
            kind: "export",
            module: spec ? spec.text : null,
            typeOnly: node.isTypeOnly,
            ...(ns ? { ns } : {}),
            named,
            quote: spec ? (spec.getText()[0] ?? '"') : '"',
            semi,
        };
    }
    return undefined;
}
function renderBinding(b) {
    const names = [];
    if (b.def)
        names.push(b.def);
    if (b.ns)
        names.push(b.ns === "*" ? "*" : `* as ${b.ns}`);
    if (b.named.length > 0)
        names.push(`{ ${b.named.join(", ")} }`);
    const type = b.typeOnly ? "type " : "";
    const end = b.semi ? ";" : "";
    if (b.kind === "import")
        return `import ${type}${names.join(", ")} from ${b.quote}${b.module}${b.quote}${end}`;
    if (b.module === null)
        return `export ${type}${names.join(", ")}${end}`;
    return `export ${type}${names.join(", ")} from ${b.quote}${b.module}${b.quote}${end}`;
}
function scalar3(base, a, b) {
    if (a === b)
        return { ok: true, value: a };
    if (base === a)
        return { ok: true, value: b };
    if (base === b)
        return { ok: true, value: a };
    return { ok: false };
}
function pick(base, a, b) {
    const r = scalar3(base, a, b);
    return r.ok && r.value !== undefined ? r.value : a;
}
function mergeBindings(base, a, b) {
    if (a.kind !== b.kind || a.module !== b.module || a.typeOnly !== b.typeOnly)
        return null;
    const def = scalar3(base?.def, a.def, b.def);
    const ns = scalar3(base?.ns, a.ns, b.ns);
    if (!def.ok || !ns.ok)
        return null;
    const baseNamed = new Set(base?.named ?? []);
    const aNamed = new Set(a.named);
    const bNamed = new Set(b.named);
    const named = [
        ...(base?.named ?? []).filter((n) => aNamed.has(n) && bNamed.has(n)),
        ...a.named.filter((n) => !baseNamed.has(n)),
        ...b.named.filter((n) => !baseNamed.has(n) && !aNamed.has(n)),
    ];
    const { def: _def, ns: _ns, ...rest } = a;
    return { ...rest, ...(def.value !== undefined ? { def: def.value } : {}), ...(ns.value !== undefined ? { ns: ns.value } : {}), named };
}
function withBody(from, lead, body, parts) {
    return { ...from, lead, body, norm: body.trim(), parts: parts ?? [body] };
}
function withBinding(from, lead, binding) {
    const body = renderBinding(binding);
    return { ...withBody(from, lead, body), binding };
}
// ---------------------------------------------------------------------------------------------
// Three-way merge of containers
function merge3(base, main, mine, at, ctx) {
    if ([base, main, mine].some((c) => c.sep && c.elems.filter((e) => e.key === "type-literal" || e.key.startsWith("type-literal#")).length > 1)) {
        ctx.conflicts.push({ at, reason: "multiple object types have ambiguous identities" });
        return main;
    }
    const baseKeys = new Set(base.elems.map((e) => e.key));
    const mainIdx = new Map(main.elems.map((e) => [e.key, e]));
    const mineIdx = new Map(mine.elems.map((e) => [e.key, e]));
    const mainIns = insertsOf(baseKeys, main);
    const mineIns = insertsOf(baseKeys, mine);
    reconcileInserts(mainIns, mineIns, mainIdx, main.fuse, at, ctx);
    const out = [];
    const gap = (anchor) => {
        for (const e of mainIns.get(anchor) ?? [])
            out.push(e);
        for (const e of mineIns.get(anchor) ?? []) {
            out.push(e);
            ctx.replayed++;
        }
    };
    // The slot of base element i on one side: the nearest preceding base element that side kept.
    const slotIn = (side, index) => {
        for (let i = index - 1; i >= 0; i--) {
            const k = base.elems[i].key;
            if (side.has(k))
                return k;
        }
        return "";
    };
    const rewrites = (inserts, slot, family) => family !== null && (inserts.get(slot) ?? []).some((e) => familyOf(e.key) === family);
    // A rewrite: one side deleted a base element and inserted another of the same family in its slot (an `if`
    // with a new condition, a call with new arguments) while the other side edited the original. The edit is
    // merged into the rewritten element instead of being reported as a modification against a deletion.
    const handled = new Set();
    base.elems.forEach((b, i) => {
        const family = familyOf(b.key);
        if (family === null)
            return;
        const m = mainIdx.get(b.key);
        const n = mineIdx.get(b.key);
        const here = `${at}/${b.key}`;
        const before = ctx.conflicts.length;
        if (!m && n && n.norm !== b.norm) {
            const slot = slotIn(mainIdx, i);
            const rw = wrapOf(mainIns, slot, b.key) ?? rewriteOf(mainIns, slot, family);
            const merged = rw ? mergeRewrite(b, rw, n, false, here, ctx) : null;
            if (rw && merged) {
                replaceInserted(mainIns, rw, merged);
                ctx.replayed++;
                handled.add(i);
            }
            else
                ctx.conflicts.length = before;
        }
        else if (m && !n && m.norm !== b.norm) {
            const slot = slotIn(mineIdx, i);
            const rw = wrapOf(mineIns, slot, b.key) ?? rewriteOf(mineIns, slot, family);
            const merged = rw ? mergeRewrite(b, rw, m, true, here, ctx) : null;
            if (rw && merged) {
                replaceInserted(mineIns, rw, merged);
                ctx.replayed++;
                handled.add(i);
            }
            else
                ctx.conflicts.length = before;
        }
    });
    gap("");
    base.elems.forEach((b, i) => {
        if (handled.has(i)) {
            gap(b.key);
            return;
        }
        const m = mainIdx.get(b.key);
        const n = mineIdx.get(b.key);
        const mainSame = m !== undefined && m.norm === b.norm;
        const mineSame = n !== undefined && n.norm === b.norm;
        const here = `${at}/${b.key}`;
        if (mainSame && mineSame)
            out.push(withBody(m, pick(b.lead, m.lead, n.lead), m.body, m.parts));
        else if (mineSame) {
            if (m)
                out.push(withBody(m, pick(b.lead, m.lead, n.lead), m.body, m.parts));
        }
        else if (mainSame) {
            if (n)
                out.push(withBody(n, pick(b.lead, m.lead, n.lead), n.body, n.parts));
            ctx.replayed++;
        }
        else if (!m && !n) {
            const family = familyOf(b.key);
            const byMain = rewrites(mainIns, slotIn(mainIdx, i), family);
            const byMine = rewrites(mineIns, slotIn(mineIdx, i), family);
            if (byMain && byMine)
                ctx.conflicts.push({ at: here, reason: "both sides rewrote it differently" });
            else if (byMain)
                ctx.conflicts.push({ at: here, reason: "deleted by the submission but rewritten on main" });
            else if (byMine)
                ctx.conflicts.push({ at: here, reason: "rewritten by the submission but deleted on main" });
        }
        else if (!m || !n) {
            ctx.conflicts.push({ at: here, reason: m ? "deleted by the submission but modified on main" : "modified by the submission but deleted on main" });
        }
        else if (m.norm === n.norm)
            out.push(withBody(m, pick(b.lead, m.lead, n.lead), m.body, m.parts));
        else {
            const merged = mergeElem(b, m, n, here, ctx);
            out.push(merged ?? m);
            if (merged)
                ctx.replayed++;
        }
        gap(b.key);
    });
    return {
        comma: main.comma,
        fuse: main.fuse,
        elems: out,
        closing: pick(base.closing, main.closing, mine.closing),
        trailing: pick(base.trailing, main.trailing, mine.trailing),
        ...(main.sep || mine.sep ? { sep: main.sep === "type" ? mine.sep ?? main.sep : main.sep ?? mine.sep } : {}),
    };
}
/** Replay into the unique surviving base element of a wrapper, retaining the wrapper's literal text. */
function mergeRewrite(base, rewrite, edit, mineWraps, at, ctx) {
    const matches = [];
    const visit = (e) => {
        for (const p of e.parts) {
            if (typeof p === "string")
                continue;
            for (const child of p.elems) {
                if (child.key.replace(/#\d+$/, "") === base.key.replace(/#\d+$/, ""))
                    matches.push(child);
                visit(child);
            }
        }
    };
    visit(rewrite);
    if (matches.length === 0)
        return mineWraps ? mergeElem(base, edit, rewrite, at, ctx) : mergeElem(base, rewrite, edit, at, ctx);
    if (matches.length !== 1)
        return null;
    const target = matches[0];
    const merged = mineWraps ? mergeElem(base, edit, target, at, ctx) : mergeElem(base, target, edit, at, ctx);
    if (!merged)
        return null;
    const replace = (e) => {
        if (e === target)
            return { ...merged, lead: target.lead };
        const parts = e.parts.map((p) => typeof p === "string" ? p : { ...p, elems: p.elems.map(replace) });
        return withBody(e, e.lead, parts.map((p) => typeof p === "string" ? p : serialize(p)).join(""), parts);
    };
    return replace(rewrite);
}
/** The one inserted element in `slot` that carries an element keyed like `baseKey` inside its nested lists: a wrap. */
function wrapOf(inserts, slot, baseKey) {
    const bare = baseKey.replace(/#\d+$/, "");
    const found = (inserts.get(slot) ?? []).filter((e) => containsKey(e, bare));
    return found.length === 1 ? found[0] : null;
}
function containsKey(e, bare) {
    for (const p of e.parts) {
        if (typeof p === "string")
            continue;
        for (const child of p.elems)
            if (child.key.replace(/#\d+$/, "") === bare || containsKey(child, bare))
                return true;
    }
    return false;
}
/** The one inserted element of `family` in `slot`, when a side rewrote a base element there; null when none or several. */
function rewriteOf(inserts, slot, family) {
    const found = (inserts.get(slot) ?? []).filter((e) => familyOf(e.key) === family);
    return found.length === 1 ? found[0] : null;
}
/** A side's inserted elements grouped by the nearest preceding base element the side kept ("" = at the start). */
function insertsOf(baseKeys, side) {
    const out = new Map();
    let anchor = "";
    for (const e of side.elems) {
        if (baseKeys.has(e.key))
            anchor = e.key;
        else {
            const list = out.get(anchor);
            if (list)
                list.push(e);
            else
                out.set(anchor, [e]);
        }
    }
    return out;
}
/**
 * Resolve the submission's insertions against main's: identical ones collapse, bindings of one module merge
 * into main's statement, two declarations of one name conflict, and anonymous elements (statements, test
 * cases) with equal keys but different text are both kept.
 */
function reconcileInserts(mainIns, mineIns, mainIdx, fuse, at, ctx) {
    for (const [anchor, list] of mineIns) {
        const kept = [];
        for (const e of list) {
            const dup = mainIdx.get(e.key);
            if (!dup) {
                kept.push(e);
                continue;
            }
            if (dup.norm === e.norm)
                continue;
            if (dup.binding && e.binding) {
                const merged = mergeBindings(undefined, dup.binding, e.binding);
                if (!merged)
                    ctx.conflicts.push({ at: `${at}/${e.key}`, reason: "both sides import different bindings from one module" });
                else
                    replaceInserted(mainIns, dup, withBinding(dup, dup.lead, merged));
                ctx.replayed++;
                continue;
            }
            if (e.identity) {
                const fused = fuse ? fuseInserted(dup, e, `${at}/${e.key}`, ctx) : null;
                if (fused) {
                    replaceInserted(mainIns, dup, fused);
                    ctx.replayed++;
                }
                else
                    ctx.conflicts.push({ at: `${at}/${e.key}`, reason: "both sides added a declaration with this name" });
                continue;
            }
            kept.push(e);
        }
        mineIns.set(anchor, kept);
    }
}
function replaceInserted(inserts, from, to) {
    for (const list of inserts.values()) {
        const i = list.indexOf(from);
        if (i >= 0)
            list[i] = to;
    }
}
/** Merge one element both sides changed: binding sets, then nested lists part by part, then its lines. */
function mergeElem(base, main, mine, at, ctx) {
    const lead = pick(base.lead, main.lead, mine.lead);
    if (base.binding && main.binding && mine.binding) {
        const merged = mergeBindings(base.binding, main.binding, mine.binding);
        if (!merged) {
            ctx.conflicts.push({ at, reason: "both sides changed the bindings differently" });
            return null;
        }
        return withBinding(main, lead, merged);
    }
    if (sameShape(base.parts, main.parts, mine.parts)) {
        const parts = [];
        let literalsMerge = true;
        const before = ctx.conflicts.length;
        for (let i = 0; i < base.parts.length && literalsMerge; i++) {
            const pb = base.parts[i];
            const pm = main.parts[i];
            const pn = mine.parts[i];
            if (typeof pb === "string") {
                const r = scalar3(pb, pm, pn);
                if (!r.ok)
                    literalsMerge = false;
                else
                    parts.push(r.value);
            }
            else
                parts.push(merge3(pb, pm, pn, at, ctx));
        }
        if (literalsMerge)
            return withBody(main, lead, parts.map((p) => (typeof p === "string" ? p : serialize(p))).join(""), parts);
        ctx.conflicts.length = before; // the structural attempt is abandoned; try the lines
    }
    const merged = merge3Text(base.body, main.body, mine.body);
    if (merged === null) {
        ctx.conflicts.push({ at, reason: "both sides modified the same lines" });
        return null;
    }
    return withBody(main, lead, merged);
}
/**
 * Two insertions of one identity in a fusing list (`options?: { a }` and `options?: { b }` as a parameter or a
 * type member): equal literal text around nested lists that merge against an empty base. Null when the
 * literals differ or a nested merge conflicts.
 */
function fuseInserted(a, b, at, ctx) {
    if (!sameShape(a.parts, b.parts, b.parts) || !a.parts.some((p) => typeof p !== "string"))
        return null;
    const before = ctx.conflicts.length;
    const parts = [];
    for (let i = 0; i < a.parts.length; i++) {
        const pa = a.parts[i];
        const pb = b.parts[i];
        if (typeof pa === "string") {
            if (pa !== pb)
                return null;
            parts.push(pa);
        }
        else
            parts.push(merge3(emptyLike(pa), pa, pb, at, ctx));
    }
    if (ctx.conflicts.length > before) {
        ctx.conflicts.length = before;
        return null;
    }
    return withBody(a, a.lead, parts.map((p) => (typeof p === "string" ? p : serialize(p))).join(""), parts);
}
function emptyLike(c) {
    return { ...c, elems: [] };
}
function sameShape(a, b, c) {
    if (a.length !== b.length || a.length !== c.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        const kinds = [a[i], b[i], c[i]].map((p) => (typeof p === "string" ? "s" : p.sep ?? (p.comma ? "c" : "l")));
        const concrete = kinds.filter((k) => k !== "type");
        if (concrete.some((k) => k !== concrete[0]))
            return false;
        if (kinds.includes("type") && concrete.some((k) => k !== "|" && k !== "&"))
            return false;
    }
    return true;
}
// ---------------------------------------------------------------------------------------------
// Serialization
function serialize(c) {
    let out = "";
    let prev;
    c.elems.forEach((e, i) => {
        let lead = e.lead;
        if (prev && !/\s/.test(lead) && /\n/.test(prev.lead))
            lead = "\n" + indentOf(prev.lead) + lead;
        out += lead + e.body;
        if (c.comma) {
            const last = i === c.elems.length - 1;
            if (!last || c.trailing)
                out += e.sep.includes(",") ? e.sep : ",";
        }
        else if (c.sep && i < c.elems.length - 1) {
            out += e.sep.includes(c.sep) ? e.sep : ` ${c.sep === "type" ? "|" : c.sep}`;
        }
        prev = e;
    });
    return out + c.closing;
}
function indentOf(lead) {
    const m = /\n([ \t]*)$/.exec(lead);
    return m ? m[1] : "";
}
// ---------------------------------------------------------------------------------------------
// Line-wise three-way merge (diff3 chunks over the longest common subsequence with the base)
function merge3Text(base, a, b) {
    const B = base.split("\n");
    const A = a.split("\n");
    const C = b.split("\n");
    const ma = lcsMap(B, A);
    const mc = lcsMap(B, C);
    if (!ma || !mc)
        return null;
    const out = [];
    let bi = 0;
    let ai = 0;
    let ci = 0;
    for (;;) {
        let s = bi;
        while (s < B.length && !(ma[s] >= 0 && mc[s] >= 0))
            s++;
        const aEnd = s < B.length ? ma[s] : A.length;
        const cEnd = s < B.length ? mc[s] : C.length;
        const bc = B.slice(bi, s);
        const ac = A.slice(ai, aEnd);
        const cc = C.slice(ci, cEnd);
        if (sameLines(ac, bc))
            out.push(...cc);
        else if (sameLines(cc, bc))
            out.push(...ac);
        else if (sameLines(ac, cc))
            out.push(...ac);
        else
            return null;
        if (s >= B.length)
            break;
        out.push(B[s]);
        bi = s + 1;
        ai = aEnd + 1;
        ci = cEnd + 1;
    }
    return out.join("\n");
}
function sameLines(a, b) {
    return a.length === b.length && a.every((line, i) => line === b[i]);
}
/** For each line of `base`, the index of the line of `other` it matches in a longest common subsequence, or -1. */
function lcsMap(base, other) {
    const n = base.length;
    const m = other.length;
    if ((n + 1) * (m + 1) > MAX_DIFF_CELLS)
        return null;
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = base[i] === other[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    const map = new Int32Array(n).fill(-1);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (base[i] === other[j]) {
            map[i] = j;
            i++;
            j++;
        }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1])
            i++;
        else
            j++;
    }
    return map;
}
//# sourceMappingURL=replay.js.map