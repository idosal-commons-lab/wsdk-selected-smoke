// Repository symbol index over the TypeScript compiler API (parse only, no type-checker).
// Data-plane module: it reads source files and may import node:* freely.
import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve as resolvePath } from "node:path";
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const DEFAULT_MAX_FILES = 5000;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];
const JS_TO_TS = [
    [/\.js$/, [".ts", ".tsx"]],
    [/\.jsx$/, [".tsx"]],
    [/\.mjs$/, [".mts"]],
    [/\.cjs$/, [".cts"]],
];
export function indexRepo(root, opts = {}) {
    const absRoot = resolvePath(root);
    const paths = walk(absRoot, opts.include, opts.exclude, opts.maxFiles ?? DEFAULT_MAX_FILES);
    const known = new Set(paths);
    const resolver = (from, spec) => resolveInRepo(from, spec, known);
    const files = [];
    for (const rel of paths) {
        let source;
        try {
            source = readFileSync(join(absRoot, rel), "utf8");
        }
        catch {
            continue;
        }
        files.push(extractCached(rel, source, resolver));
    }
    const byPath = new Map();
    const importers = new Map();
    for (const file of files) {
        byPath.set(file.path, file);
        importers.set(file.path, []);
    }
    for (const file of files)
        for (const dep of file.imports)
            importers.get(dep)?.push(file.path);
    return { root: absRoot, commit: opts.commit ?? "", files, byPath, importers };
}
/**
 * Parsed files by path, with the content they were parsed from and every import resolution the parse asked for. An
 * integrator indexes one tree per candidate, and candidates differ from each other by a few files: a file is parsed
 * again only when its content changed or one of its imports now resolves elsewhere (a file added or removed). On the
 * workers-sdk base a full index took about 6 s.
 */
const parsed = new Map();
const MAX_CACHED = 50_000;
/**
 * The same on disk, shared by every process on the machine: an agent's MCP server indexes the whole repository at its
 * first submit, in a process that has parsed nothing yet. On workers-sdk that took 11 s at a load of 22 and was most of
 * a submit's 32 to 47 s median; a submission is not queued until submit returns. Entries are keyed by path and content
 * (COMMONS_INDEX_CACHE, default ~/.commons/index; empty or "off" disables it), immutable, and written atomically.
 */
function diskCacheDir() {
    const dir = process.env.COMMONS_INDEX_CACHE;
    if (dir === "" || dir === "off")
        return null;
    return dir ?? join(homedir(), ".commons", "index");
}
function diskKey(path, source) {
    return createHash("sha1").update(EXTRACT_VERSION).update("\0").update(path).update("\0").update(source).digest("hex");
}
/** Bumped when what `extract` produces changes, so older entries are not read back. */
const EXTRACT_VERSION = "1";
function fromDisk(dir, key) {
    try {
        return JSON.parse(readFileSync(join(dir, key.slice(0, 2), `${key}.json`), "utf8"));
    }
    catch {
        return null;
    }
}
function toDisk(dir, key, entry) {
    try {
        const sub = join(dir, key.slice(0, 2));
        mkdirSync(sub, { recursive: true });
        const tmp = join(sub, `.${key}.${process.pid}.tmp`);
        writeFileSync(tmp, JSON.stringify(entry));
        renameSync(tmp, join(sub, `${key}.json`));
    }
    catch {
        // a cache: a failed write costs a parse next time
    }
}
function extractCached(path, source, resolve) {
    const hit = parsed.get(path);
    if (hit && hit.source === source && hit.calls.every(([spec, result]) => resolve(path, spec) === result))
        return hit.symbols;
    const dir = diskCacheDir();
    const key = dir ? diskKey(path, source) : "";
    const stored = dir ? fromDisk(dir, key) : null;
    if (stored && stored.calls.every(([spec, result]) => resolve(path, spec) === result)) {
        if (parsed.size >= MAX_CACHED)
            parsed.clear();
        parsed.set(path, { source, calls: stored.calls, symbols: stored.symbols });
        return stored.symbols;
    }
    const calls = [];
    const symbols = extract(path, source, (from, spec) => {
        const result = resolve(from, spec);
        if (from === path)
            calls.push([spec, result]);
        return result;
    });
    if (parsed.size >= MAX_CACHED)
        parsed.clear();
    parsed.set(path, { source, calls, symbols });
    if (dir)
        toDisk(dir, key, { calls, symbols });
    return symbols;
}
/**
 * Parse one file. Imports are relative specifiers normalized against `path` (packages are
 * dropped); `indexRepo` additionally resolves them against the files that exist in the repo.
 */
export function extractFileSymbols(path, source) {
    return extract(path, source, (from, spec) => (isRelative(spec) ? relativeCandidate(from, stripQuery(spec)) : null));
}
// ---------------------------------------------------------------------------------------------
// File walking and import resolution
function walk(absRoot, include, exclude, maxFiles) {
    const out = [];
    const visit = (dirAbs, relDir) => {
        let entries;
        try {
            entries = readdirSync(dirAbs, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (out.length >= maxFiles)
                return;
            if (entry.isSymbolicLink())
                continue;
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name))
                    continue;
                if (exclude && (matches(exclude, rel) || matches(exclude, rel + "/")))
                    continue;
                visit(join(dirAbs, entry.name), rel);
            }
            else if (entry.isFile()) {
                if (!SOURCE_FILE.test(entry.name))
                    continue;
                if (include && !matches(include, rel))
                    continue;
                if (exclude && matches(exclude, rel))
                    continue;
                out.push(rel);
            }
        }
    };
    visit(absRoot, "");
    return out;
}
function matches(re, s) {
    re.lastIndex = 0;
    return re.test(s);
}
function isRelative(spec) {
    return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}
function stripQuery(spec) {
    return spec.split(/[?#]/)[0] ?? "";
}
/** Normalize a relative specifier against the importing file; null when it escapes the repo. */
function relativeCandidate(fromPath, spec) {
    const candidate = posix.normalize(posix.join(posix.dirname(fromPath), spec));
    if (candidate === ".." || candidate.startsWith("../") || posix.isAbsolute(candidate))
        return null;
    return candidate === "." ? "" : candidate;
}
function resolveInRepo(fromPath, spec, known) {
    const clean = stripQuery(spec);
    if (!clean)
        return null;
    let candidate;
    if (isRelative(clean))
        candidate = relativeCandidate(fromPath, clean);
    else if (clean.startsWith("/") || clean.startsWith("@"))
        candidate = null;
    else
        candidate = posix.normalize(clean); // baseUrl-style "src/x" resolves only if it exists
    if (candidate === null || candidate.startsWith("../"))
        return null;
    return resolveCandidate(candidate, known);
}
function resolveCandidate(candidate, known) {
    if (candidate && known.has(candidate))
        return candidate;
    for (const [re, exts] of JS_TO_TS) {
        if (!re.test(candidate))
            continue;
        for (const ext of exts) {
            const mapped = candidate.replace(re, ext);
            if (known.has(mapped))
                return mapped;
        }
    }
    if (candidate)
        for (const ext of RESOLVE_EXTENSIONS)
            if (known.has(candidate + ext))
                return candidate + ext;
    const dir = candidate ? candidate + "/" : "";
    for (const index of INDEX_FILES)
        if (known.has(dir + index))
            return dir + index;
    return null;
}
// ---------------------------------------------------------------------------------------------
// Symbol extraction
function scriptKindFor(path) {
    if (path.endsWith(".tsx"))
        return ts.ScriptKind.TSX;
    if (path.endsWith(".jsx"))
        return ts.ScriptKind.JSX;
    if (/\.(?:js|mjs|cjs)$/.test(path))
        return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
}
function extract(path, source, resolve) {
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFor(path));
    const locals = new Map();
    for (const st of sf.statements)
        collectLocals(st, locals);
    const exports = [];
    const addExport = (entry) => {
        const existing = exports.find((e) => e.name === entry.name);
        if (!existing) {
            exports.push(entry);
            return;
        }
        const parts = existing.signature.split(" | ");
        for (const part of entry.signature.split(" | "))
            if (!parts.includes(part))
                parts.push(part);
        existing.signature = parts.join(" | ");
    };
    const specifiers = [];
    const rawBindings = [];
    const addSpecifier = (node) => {
        if (node && ts.isStringLiteralLike(node))
            specifiers.push(node.text);
    };
    const addBinding = (node, names, reexport) => {
        if (node && ts.isStringLiteralLike(node))
            rawBindings.push({ spec: node.text, names, reexport });
    };
    let onlyReexports = true;
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st)) {
            addSpecifier(st.moduleSpecifier);
            const clause = st.importClause;
            if (!clause)
                addBinding(st.moduleSpecifier, "*", false);
            else {
                const names = [];
                let star = false;
                if (clause.name)
                    names.push("default");
                if (clause.namedBindings) {
                    if (ts.isNamespaceImport(clause.namedBindings))
                        star = true;
                    else
                        for (const el of clause.namedBindings.elements)
                            names.push((el.propertyName ?? el.name).text);
                }
                addBinding(st.moduleSpecifier, star ? "*" : names, false);
            }
            if (!clause?.isTypeOnly)
                onlyReexports = onlyReexports && true;
            continue;
        }
        if (ts.isImportEqualsDeclaration(st)) {
            if (ts.isExternalModuleReference(st.moduleReference))
                addSpecifier(st.moduleReference.expression);
            continue;
        }
        if (ts.isExportDeclaration(st)) {
            addSpecifier(st.moduleSpecifier);
            if (st.moduleSpecifier) {
                const clause = st.exportClause;
                if (!clause || ts.isNamespaceExport(clause))
                    addBinding(st.moduleSpecifier, "*", true);
                else
                    addBinding(st.moduleSpecifier, clause.elements.map((el) => (el.propertyName ?? el.name).text), true);
            }
            else
                onlyReexports = false;
            for (const entry of exportDeclarationEntries(st, locals, sf))
                addExport(entry);
            continue;
        }
        onlyReexports = false;
        if (ts.isExportAssignment(st)) {
            addExport(exportAssignmentEntry(st, locals, sf));
            continue;
        }
        if (ts.isExpressionStatement(st)) {
            for (const entry of commonJsEntries(st, locals, sf))
                addExport(entry);
            continue;
        }
        if (!ts.canHaveModifiers(st))
            continue;
        const mods = ts.getModifiers(st) ?? [];
        if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
            continue;
        const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
        if (ts.isVariableStatement(st)) {
            for (const name of declaredNames(st))
                addExport(buildEntry(locals.get(name) ?? [], name, sf));
            continue;
        }
        if (!isNamedDeclaration(st))
            continue;
        const name = declarationName(st);
        if (name === undefined) {
            // Anonymous `export default function () {}` / `export default class {}`.
            if (ts.isFunctionDeclaration(st))
                addExport({ name: "default", kind: "function", signature: callSignature("default", st, sf) });
            else if (ts.isClassDeclaration(st))
                addExport(classEntry(st, "default", sf));
            continue;
        }
        const entry = buildEntry(locals.get(name) ?? [st], name, sf);
        addExport(isDefault ? { ...entry, name: "default" } : entry);
    }
    // Dynamic import() and require() calls anywhere in the file.
    const visit = (node) => {
        if (ts.isCallExpression(node) && node.arguments.length > 0) {
            const callee = node.expression;
            const arg = node.arguments[0];
            const isImport = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
            if (isImport && arg && ts.isStringLiteralLike(arg))
                specifiers.push(arg.text);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    const imports = [];
    const seen = new Set();
    for (const spec of specifiers) {
        const resolved = resolve(path, spec);
        if (resolved !== null && resolved !== "" && !seen.has(resolved)) {
            seen.add(resolved);
            imports.push(resolved);
        }
    }
    const bindings = [];
    for (const b of rawBindings) {
        const from = resolve(path, b.spec);
        if (from === null || from === "")
            continue;
        bindings.push({ from, names: b.names, reexport: b.reexport });
    }
    const pureBarrel = onlyReexports && rawBindings.some((b) => b.reexport) && !rawBindings.some((b) => !b.reexport);
    return { path, exports, imports, bindings, pureBarrel };
}
function isNamedDeclaration(st) {
    return (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st) ||
        ts.isModuleDeclaration(st));
}
function declarationName(st) {
    if (!isNamedDeclaration(st) || !st.name)
        return undefined;
    return ts.isIdentifier(st.name) ? st.name.text : ts.isStringLiteral(st.name) ? st.name.text : undefined;
}
function collectLocals(st, locals) {
    const push = (name, decl) => {
        const list = locals.get(name);
        if (list)
            list.push(decl);
        else
            locals.set(name, [decl]);
    };
    if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations)
            collectBindingNames(decl.name, decl, push);
        return;
    }
    if (!isNamedDeclaration(st))
        return;
    const name = declarationName(st);
    if (name !== undefined)
        push(name, st);
}
function collectBindingNames(name, decl, push) {
    if (ts.isIdentifier(name)) {
        push(name.text, decl);
        return;
    }
    for (const element of name.elements) {
        if (ts.isOmittedExpression(element))
            continue;
        if (ts.isIdentifier(element.name))
            push(element.name.text, element);
        else
            collectBindingNames(element.name, decl, push);
    }
}
function declaredNames(st) {
    const names = [];
    for (const decl of st.declarationList.declarations)
        collectBindingNames(decl.name, decl, (n) => names.push(n));
    return names;
}
function unique(items) {
    return [...new Set(items)];
}
/** Build one export entry for `name` from all of its local declarations (merging overloads). */
function buildEntry(nodes, name, sf) {
    const fns = nodes.filter(ts.isFunctionDeclaration);
    if (fns.length > 0) {
        const overloads = fns.filter((f) => !f.body);
        const use = overloads.length > 0 ? overloads : fns;
        return { name, kind: "function", signature: unique(use.map((f) => callSignature(name, f, sf))).join(" | ") };
    }
    const node = nodes[0];
    if (!node)
        return { name, kind: "other", signature: name };
    if (ts.isClassDeclaration(node))
        return classEntry(node, name, sf);
    if (ts.isInterfaceDeclaration(node)) {
        const decls = nodes.filter(ts.isInterfaceDeclaration);
        return { name, kind: "interface", signature: unique(decls.map((d) => interfaceSignature(d, name, sf))).join(" | ") };
    }
    if (ts.isTypeAliasDeclaration(node)) {
        return { name, kind: "type", signature: `type ${name}${typeParams(node.typeParameters, sf)} = ${print(node.type, sf)}` };
    }
    if (ts.isEnumDeclaration(node)) {
        const members = node.members.map((m) => print(m, sf));
        return { name, kind: "enum", signature: `enum ${name} ${members.length ? `{ ${members.join(", ")} }` : "{}"}` };
    }
    if (ts.isModuleDeclaration(node))
        return { name, kind: "other", signature: `namespace ${name}` };
    if (ts.isVariableDeclaration(node))
        return variableEntry(node, name, sf);
    return { name, kind: "const", signature: name }; // destructured binding element
}
function variableEntry(node, name, sf) {
    if (node.type)
        return { name, kind: "const", signature: `${name}: ${print(node.type, sf)}` };
    const init = node.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        return { name, kind: "const", signature: callSignature(name, init, sf) };
    }
    return { name, kind: "const", signature: name };
}
function entryForValue(name, value, locals, sf) {
    if (ts.isIdentifier(value)) {
        const decls = locals.get(value.text);
        if (decls)
            return { ...buildEntry(decls, value.text, sf), name };
    }
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        return { name, kind: "function", signature: callSignature(name, value, sf) };
    }
    if (ts.isClassExpression(value))
        return { ...classEntry(value, value.name?.text ?? name, sf), name };
    return { name, kind: "other", signature: name };
}
function exportDeclarationEntries(st, locals, sf) {
    const clause = st.exportClause;
    if (!clause)
        return []; // export * from "./x": names unknown without the other file
    if (ts.isNamespaceExport(clause))
        return [{ name: clause.name.text, kind: "other", signature: clause.name.text }];
    return clause.elements.map((element) => {
        const exported = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        if (!st.moduleSpecifier) {
            const decls = locals.get(local);
            if (decls)
                return buildEntry(decls, exported, sf);
        }
        const kind = st.isTypeOnly || element.isTypeOnly ? "type" : "other";
        return { name: exported, kind, signature: exported };
    });
}
function exportAssignmentEntry(st, locals, sf) {
    const expr = st.expression;
    if (ts.isIdentifier(expr)) {
        const decls = locals.get(expr.text);
        if (decls)
            return { ...buildEntry(decls, expr.text, sf), name: "default" };
    }
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        const local = ts.isFunctionExpression(expr) && expr.name ? expr.name.text : "default";
        return { name: "default", kind: "function", signature: callSignature(local, expr, sf) };
    }
    if (ts.isClassExpression(expr))
        return { ...classEntry(expr, expr.name?.text ?? "default", sf), name: "default" };
    return { name: "default", kind: "other", signature: "default" };
}
/** CommonJS: `exports.x = ...`, `module.exports.x = ...`, `module.exports = { ... }`. */
function commonJsEntries(st, locals, sf) {
    const expr = st.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        return [];
    const left = expr.left;
    if (!ts.isPropertyAccessExpression(left) || !ts.isIdentifier(left.name))
        return [];
    const target = left.expression;
    const isModuleExports = ts.isIdentifier(target) && target.text === "module" && left.name.text === "exports";
    const isExportsObject = (ts.isIdentifier(target) && target.text === "exports") ||
        (ts.isPropertyAccessExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === "module" &&
            ts.isIdentifier(target.name) &&
            target.name.text === "exports");
    if (isExportsObject)
        return [entryForValue(left.name.text, expr.right, locals, sf)];
    if (!isModuleExports)
        return [];
    if (!ts.isObjectLiteralExpression(expr.right))
        return [{ ...entryForValue("default", expr.right, locals, sf), name: "default" }];
    const entries = [];
    for (const prop of expr.right.properties) {
        if (ts.isShorthandPropertyAssignment(prop))
            entries.push(entryForValue(prop.name.text, prop.name, locals, sf));
        else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            entries.push(entryForValue(prop.name.text, prop.initializer, locals, sf));
        }
        else if (ts.isMethodDeclaration(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            entries.push({ name: prop.name.text, kind: "function", signature: callSignature(prop.name.text, prop, sf) });
        }
    }
    return entries;
}
// ---------------------------------------------------------------------------------------------
// Signature text
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
/** Print a node with comments removed and whitespace collapsed to single spaces. */
function print(node, sf) {
    let text;
    try {
        text = printer.printNode(ts.EmitHint.Unspecified, node, sf);
    }
    catch {
        text = node.getText(sf);
    }
    return normalize(text);
}
function normalize(text) {
    return text
        .replace(/\s+/g, " ")
        .replace(/\s*[;,]\s*}/g, " }")
        .replace(/{\s+}/g, "{}")
        .replace(/;\s*$/, "")
        .trim();
}
function typeParams(list, sf) {
    return list && list.length > 0 ? `<${list.map((p) => print(p, sf)).join(", ")}>` : "";
}
function paramList(node, sf) {
    return node.parameters.map((p) => print(p, sf)).join(", ");
}
/** `name<T>(params): returnType` as written (no body). */
function callSignature(name, node, sf) {
    const ret = node.type ? `: ${print(node.type, sf)}` : "";
    return `${name}${typeParams(node.typeParameters, sf)}(${paramList(node, sf)})${ret}`;
}
function interfaceSignature(node, name, sf) {
    const heritage = node.heritageClauses?.length ? " " + node.heritageClauses.map((h) => normalize(h.getText(sf))).join(" ") : "";
    const members = node.members.map((m) => print(m, sf));
    return `interface ${name}${typeParams(node.typeParameters, sf)}${heritage} ${members.length ? `{ ${members.join("; ")} }` : "{}"}`;
}
/** `class Name<T>` plus the public constructor, methods and accessors. */
function classEntry(node, name, sf) {
    const hasOverloads = new Set();
    for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) && !member.body)
            hasOverloads.add("constructor");
        else if (ts.isMethodDeclaration(member) && !member.body)
            hasOverloads.add(print(member.name, sf));
    }
    const members = [];
    for (const member of node.members) {
        const mods = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
        if (mods.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword))
            continue;
        if (member.name && ts.isPrivateIdentifier(member.name))
            continue;
        const prefix = mods.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ? "static " : "";
        if (ts.isConstructorDeclaration(member)) {
            if (member.body && hasOverloads.has("constructor"))
                continue;
            members.push(`constructor(${paramList(member, sf)})`);
        }
        else if (ts.isMethodDeclaration(member)) {
            const memberName = print(member.name, sf);
            if (member.body && hasOverloads.has(memberName))
                continue;
            members.push(prefix + callSignature(memberName + (member.questionToken ? "?" : ""), member, sf));
        }
        else if (ts.isGetAccessorDeclaration(member)) {
            members.push(`${prefix}get ${print(member.name, sf)}()${member.type ? `: ${print(member.type, sf)}` : ""}`);
        }
        else if (ts.isSetAccessorDeclaration(member)) {
            members.push(`${prefix}set ${print(member.name, sf)}(${paramList(member, sf)})`);
        }
    }
    const body = members.length ? ` { ${unique(members).join("; ")} }` : "";
    return { name, kind: "class", signature: `class ${name}${typeParams(node.typeParameters, sf)}${body}` };
}
//# sourceMappingURL=symbols.js.map