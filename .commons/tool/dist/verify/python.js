// Python's stdlib-only coverage adapter. Helpers run isolated, with bytecode writes disabled; project imports are
// enabled explicitly inside the bootstrap, rather than through PYTHONPATH (which -I ignores).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { exec, groupByPackage, packageDirIn } from "./workspace.js";
const MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"];
const SKIP = new Set([".git", "node_modules", ".venv", "venv", ".tox", "site-packages", "__pycache__", ".commons", "dist", "build", ".turbo", ".wrangler", ".next", "coverage"]);
export const isPythonPackage = (repo, dir) => MARKERS.some((f) => existsSync(join(repo, dir, f)));
export const isPythonTest = (file) => /(^|\/)(tests?|__tests__)(\/|$)|(^|\/)(conftest|test_[^/]*|[^/]*_test)\.py$/.test(file);
function walk(root, visit) {
    const entries = readdirSync(root, { withFileTypes: true });
    visit(root, entries.filter((e) => e.isFile()).map((e) => e.name));
    // Do not follow directory symlinks into environments or outside the project.
    for (const e of entries)
        if (e.isDirectory() && !SKIP.has(e.name) && !existsSync(join(root, e.name, "pyvenv.cfg")))
            walk(join(root, e.name), visit);
}
const discovered = new Map();
/**
 * Python project roots of a repository: directories with a project marker that also have tests (a tests/ or test/
 * directory, a conftest.py, or test_*.py / *_test.py files at their top). A marker without tests is a template or an
 * example, not a project to check (create-cloudflare ships several). Memoized per repository for the process.
 */
export function pythonPackageDirs(repo) {
    const known = discovered.get(repo);
    if (known)
        return known;
    const dirs = [];
    walk(repo, (dir, files) => {
        if (!MARKERS.some((f) => files.includes(f)))
            return;
        const hasTests = files.some((f) => f === "conftest.py" || f === "pytest.ini" || f === "tox.ini" || /^test_.*\.py$|_test\.py$/.test(f)) ||
            ["tests", "test"].some((d) => existsSync(join(dir, d)));
        if (hasTests)
            dirs.push(relative(repo, dir).split("\\").join("/") || ".");
    });
    dirs.sort();
    discovered.set(repo, dirs);
    return dirs;
}
/** A .py file belongs to its deepest Python root even when a nested JS package contains it. */
export function groupWithPython(files, dirs, pythonDirs) {
    if (!pythonDirs.length)
        return groupByPackage(files, dirs);
    const out = new Map();
    for (const file of files) {
        const dir = (file.endsWith(".py") ? packageDirIn(file, pythonDirs) : null) ?? packageDirIn(file, dirs);
        if (dir !== null)
            out.set(dir, [...(out.get(dir) ?? []), dir === "." ? file : file.slice(dir.length + 1)]);
    }
    return out;
}
export function pythonInterpreter(root) {
    if (process.env.COMMONS_PYTHON)
        return process.env.COMMONS_PYTHON;
    return [".venv/bin/python", "venv/bin/python"].map((f) => join(root, f)).find(existsSync) ?? "python3";
}
/** JSON stdin: file contents, plus the project root for conservative detection of values read by other modules. */
export const PYTHON_AST_SOURCE = String.raw `
import ast, io, json, os, sys, tokenize
request = json.load(sys.stdin)
external = set()
star = False
skip = {'.git', 'node_modules', '.venv', 'venv', '.tox', 'site-packages', '__pycache__', '.commons'}
if request.get('root'):
    for directory, dirs, files in os.walk(request['root']):
        dirs[:] = [d for d in dirs if d not in skip and not os.path.isfile(os.path.join(directory, d, 'pyvenv.cfg'))]
        for file in files:
            if not file.endswith('.py'):
                continue
            try:
                with tokenize.open(os.path.join(directory, file)) as f:
                    tree = ast.parse(f.read())
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom):
                        external.update(a.name for a in node.names)
                        star = star or any(a.name == '*' for a in node.names)
                    elif isinstance(node, ast.Attribute):
                        external.add(node.attr)
            except (OSError, SyntaxError, UnicodeError):
                pass
out = {}
for file, code in request['files'].items():
    try:
        tree = ast.parse(code, filename=file)
        functions = []
        doclines = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                start = min([node.lineno] + [d.lineno for d in node.decorator_list])
                functions.append({'id': '%s#%d:%d' % (file, start, node.col_offset), 'start': start, 'end': node.end_lineno})
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
                first = node.body[0]
                if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                    doclines.update(range(first.lineno, first.end_lineno + 1))
        statements = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            def assigned(statement):
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    return set()
                if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                    targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                    return {n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)}
                return set().union(*(assigned(child) for child in ast.iter_child_nodes(statement)))
            names = assigned(node)
            touches_all = any(isinstance(n, ast.Name) and n.id == '__all__' for n in ast.walk(node))
            exported = touches_all or any(not n.startswith('_') and (n.isupper() or n in external or star) for n in names)
            start = min([node.lineno] + [d.lineno for d in getattr(node, 'decorator_list', [])])
            statements.append({'start': start, 'end': node.end_lineno, 'scope': 'exported' if exported else 'file'})
        active = set()
        ignored = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER}
        for token in tokenize.generate_tokens(io.StringIO(code).readline):
            if token.type not in ignored:
                active.update(range(token.start[0], token.end[0] + 1))
        out[file] = {'functions': sorted(functions, key=lambda s: (s['start'], s['end'])), 'statements': statements, 'active': sorted(active - doclines)}
    except (SyntaxError, tokenize.TokenError, IndentationError):
        out[file] = None
print(json.dumps(out))
`;
export function pythonSpans(root, files) {
    return JSON.parse(execFileSync(pythonInterpreter(root), ["-I", "-B", "-c", PYTHON_AST_SOURCE], {
        cwd: root, input: JSON.stringify({ root, files }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    }));
}
function pythonSources(root) {
    const files = {};
    walk(root, (dir, names) => {
        for (const name of names) {
            const rel = relative(root, join(dir, name)).split("\\").join("/");
            if (name.endsWith(".py") && !isPythonTest(rel))
                files[rel] = readFileSync(join(dir, name), "utf8");
        }
    });
    const nested = pythonPackageDirs(root).filter((d) => d !== ".");
    return Object.fromEntries(Object.entries(files).filter(([f]) => !nested.some((d) => f.startsWith(`${d}/`))));
}
export function pythonRunner(root) {
    const out = execFileSync(pythonInterpreter(root), ["-I", "-B", "-c", "try:\n import pytest\nexcept ImportError:\n print('unittest')\nelse:\n print('pytest')"], { cwd: root, encoding: "utf8" });
    return out.trim() === "pytest" ? "pytest" : "unittest";
}
// -I removes the working directory; restore only explicit project import roots for both runners.
const PYTHON_PATH_SOURCE = String.raw `
import os, sys
root = os.path.realpath(sys.argv[1])
os.chdir(root)
sys.path[:0] = [root, os.path.join(root, 'src')]
`;
function discoveryRoot(root) {
    return existsSync(join(root, "tests")) && !existsSync(join(root, "tests", "__init__.py")) ? join(root, "tests") : root;
}
export const PYTHON_RUN_SOURCE = PYTHON_PATH_SOURCE + String.raw `
import runpy
runner = sys.argv[2]
sys.path.insert(0, sys.argv[3])
sys.argv = [runner] + sys.argv[4:]
runpy.run_module(runner, run_name='__main__', alter_sys=True)
`;
/** Use the project as discovery top level, or tests/ for projects without an importable tests package. */
export function pythonTestCommand(root, runner, files) {
    const discovery = discoveryRoot(root);
    const selected = files?.map((f) => {
        if (runner === "pytest")
            return f;
        const rel = relative(discovery, join(root, f));
        return (rel.startsWith("..") ? f : rel).replace(/\.py$/, "").split(/[\\/]/).join(".");
    });
    const args = runner === "pytest" ? ["-p", "no:cacheprovider", ...(selected ?? [])] : selected ?? ["discover", "-s", discovery, "-t", discovery];
    return { cmd: pythonInterpreter(root), args: ["-I", "-B", "-c", PYTHON_RUN_SOURCE, resolve(root), runner, discovery, ...args] };
}
export async function runPythonTests(root, files) {
    if (files?.length === 0)
        return { code: 0, stdout: "", stderr: "" };
    const command = pythonTestCommand(root, pythonRunner(root), files);
    const r = await exec(command.cmd, command.args, { cwd: root });
    // Exit 5: no tests were collected (pytest) or ran (unittest on Python 3.12+): nothing failed.
    return r.code === 5 ? { ...r, code: 0 } : r;
}
/** The monitoring callback sees real code objects; decorated functions use the first decorator's line. */
export const PYTHON_COVERAGE_SOURCE = PYTHON_PATH_SOURCE + String.raw `
import datetime, inspect, json, types, unittest
with open(sys.argv[2], encoding='utf8') as f:
    request = json.load(f)
sys.path.insert(0, request['discoveryRoot'])
functions = request['functions']
lookup = {}
for file, spans in functions.items():
    for span in spans:
        lookup[(os.path.realpath(os.path.join(root, file)), span['start'])] = span['id']
hits, tests, unowned = {}, set(), set()
filenames = {}
current = None
def test_file(path):
    path = os.path.realpath(str(path))
    if os.path.commonpath([root, path]) != root:
        raise ValueError('test outside project: ' + path)
    return os.path.relpath(path, root).replace(os.sep, '/')
def hit(code):
    path = filenames.get(code.co_filename)
    if path is None:
        path = os.path.realpath(code.co_filename)
        filenames[code.co_filename] = path
    id = lookup.get((path, code.co_firstlineno))
    # Class/module code can have the same first line as a method; only function code is eligible.
    if id is not None and code.co_flags & inspect.CO_NEWLOCALS:
        if current is None:
            unowned.add(id)
        else:
            hits.setdefault(id, set()).add(current)
tool = None
if hasattr(sys, 'monitoring') and not request.get('forceTrace'):
    monitoring = sys.monitoring
    for candidate in [monitoring.COVERAGE_ID] + [i for i in range(6) if i != monitoring.COVERAGE_ID]:
        if monitoring.get_tool(candidate) is None:
            monitoring.use_tool_id(candidate, 'commons-tia')
            tool = candidate
            break
if tool is not None:
    def started(code, offset):
        hit(code)
    # Resume events cover generator/async bodies too; PY_START alone only sees their creation on some versions.
    events = monitoring.events.PY_START | monitoring.events.PY_RESUME
    monitoring.register_callback(tool, monitoring.events.PY_START, started)
    monitoring.register_callback(tool, monitoring.events.PY_RESUME, started)
    monitoring.set_events(tool, events)
else:
    def trace(frame, event, arg):
        if event == 'call':
            hit(frame.f_code)
        return trace
    sys.settrace(trace)
code = 1
try:
    if request['runner'] == 'pytest':
        import pytest
        plugin = types.ModuleType('commons_python_tia')
        @pytest.hookimpl(hookwrapper=True, tryfirst=True)
        def pytest_runtest_protocol(item, nextitem):
            global current
            current = test_file(item.path if hasattr(item, 'path') else item.fspath)
            tests.add(current)
            try:
                yield
            finally:
                current = None
        plugin.pytest_runtest_protocol = pytest_runtest_protocol
        sys.modules[plugin.__name__] = plugin
        code = int(pytest.main(['-p', 'no:cacheprovider', '-p', plugin.__name__]))
    else:
        def cases(suite):
            for test in suite:
                if isinstance(test, unittest.TestSuite):
                    yield from cases(test)
                else:
                    yield test
        loaded = unittest.defaultTestLoader.discover(start_dir=request['discoveryRoot'], top_level_dir=request['discoveryRoot'])
        # Keep TestSuite's class/module fixture handling, while attributing each actual case (including setUp/tearDown).
        class Result(unittest.TextTestResult):
            def startTest(self, test):
                global current
                current = test_file(sys.modules[test.__class__.__module__].__file__)
                tests.add(current)
                super().startTest(test)
            def stopTest(self, test):
                global current
                super().stopTest(test)
                current = None
        result = unittest.TextTestRunner(resultclass=Result).run(unittest.TestSuite(cases(loaded)))
        code = 0 if result.wasSuccessful() else 1
finally:
    if tool is not None:
        monitoring.set_events(tool, 0)
        monitoring.register_callback(tool, monitoring.events.PY_START, None)
        monitoring.register_callback(tool, monitoring.events.PY_RESUME, None)
        monitoring.free_tool_id(tool)
    else:
        sys.settrace(None)
    # Collection/import and class/module fixture calls have no individual owner; conservatively retain every test.
    for id in unowned:
        hits.setdefault(id, set()).update(tests)
    with open(sys.argv[3], 'w', encoding='utf8') as f:
        json.dump({'root': request['base'], 'packageDir': request['packageDir'], 'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'functions': functions, 'hits': {id: sorted(ts) for id, ts in hits.items()}, 'tests': sorted(tests)}, f)
sys.exit(code)
`;
export async function buildPythonMap(o) {
    const root = join(o.repo, o.packageDir);
    const spans = pythonSpans(root, pythonSources(root));
    if (Object.values(spans).some((s) => s === null)) {
        o.log?.(`${o.packageDir}: Python source could not be parsed; no coverage map`);
        return null;
    }
    const functions = Object.fromEntries(Object.entries(spans).map(([file, info]) => [file, info.functions]));
    const work = mkdtempSync(join(tmpdir(), "commons-python-tia-"));
    try {
        const out = join(work, "map.json");
        const request = join(work, "request.json");
        writeFileSync(request, JSON.stringify({ functions, base: o.root, packageDir: o.packageDir, runner: pythonRunner(root), discoveryRoot: discoveryRoot(root), forceTrace: o.forceTrace }));
        const r = await exec(pythonInterpreter(root), ["-I", "-B", "-c", PYTHON_COVERAGE_SOURCE, resolve(root), request, out], { cwd: root });
        // A failed/incomplete baseline must never become evidence for narrowing future checks.
        if (r.code !== 0 || !existsSync(out)) {
            o.log?.(`${o.packageDir}: Python coverage run failed (exit ${r.code}); no map: ${`${r.stdout}\n${r.stderr}`.slice(-1500)}`);
            return null;
        }
        const map = JSON.parse(readFileSync(out, "utf8"));
        if (!map.tests.length)
            return null;
        o.log?.(`coverage map of ${o.packageDir}: ${map.tests.length} test files, ${Object.keys(map.hits).length} executed functions`);
        return map;
    }
    finally {
        rmSync(work, { recursive: true, force: true });
    }
}
/** Same contract as selectTests, with Python's all-suite fallback instead of vitest related. */
export function selectPythonTests(map, changed, hunks, packageDir, read, root) {
    const run = new Set();
    const notes = [];
    const all = (file, why) => {
        for (const test of map.tests)
            run.add(test);
        notes.push(`${file}: ${why}, all tests`);
    };
    for (const file of changed) {
        if (map.tests.includes(file) || /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(file)) {
            if (read(file, "current") !== null)
                run.add(file);
            else
                all(file, "deleted test file");
            continue;
        }
        const base = read(file, "base");
        const current = read(file, "current");
        if (file.endsWith(".py") && !isPythonTest(file) && base === null && current !== null) {
            notes.push(`${file}: new file, exercised through the changed code that imports it`);
            continue;
        }
        const spans = map.functions[file];
        if (!spans) {
            all(file, "not in the coverage map");
            continue;
        }
        const changes = hunks.get(packageDir === "." ? file : `${packageDir}/${file}`) ?? [];
        if (!changes.length) {
            all(file, "no diff hunks available");
            continue;
        }
        const touched = new Set();
        let info;
        try {
            const parsed = pythonSpans(root, { ...(base !== null ? { base } : {}), ...(current !== null ? { current } : {}) });
            info = { base: parsed.base ?? null, current: parsed.current ?? null };
        }
        catch {
            all(file, "source parsing unavailable");
            continue;
        }
        if ((base !== null && !info.base) || (current !== null && !info.current)) {
            all(file, "source could not be parsed");
            continue;
        }
        const outside = { base: [], current: [] };
        const inner = (line, insertion = false) => spans.filter((s) => s.start <= line && line + Number(insertion) <= s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
        for (const h of changes) {
            let module = h.count === 0 && !inner(h.start, true);
            if (h.count === 0) {
                const s = inner(h.start, true);
                if (s)
                    touched.add(s.id);
            }
            for (let line = h.start; line < h.start + h.count; line++) {
                const s = inner(line);
                if (s)
                    touched.add(s.id);
                else {
                    outside.base.push(line);
                    module = true;
                }
            }
            for (let line = h.newStart; line < h.newStart + h.newCount; line++) {
                // A replacement can dedent out of a base function into a new module statement.
                if (module || !info.current?.functions.some((s) => s.start <= line && line <= s.end))
                    outside.current.push(line);
            }
        }
        let scope = "inert";
        for (const side of ["base", "current"]) {
            if (!outside[side].length)
                continue;
            const parsed = info[side];
            if (!parsed)
                continue; // deleted file: the base supplies its classification
            for (const line of outside[side]) {
                if (!parsed.active.includes(line))
                    continue;
                const statement = parsed.statements.find((s) => s.start <= line && line <= s.end);
                if (!statement) {
                    scope = "unknown";
                    break;
                }
                if (statement.scope === "exported")
                    scope = "exported";
                else if (scope === "inert")
                    scope = "file";
            }
        }
        if (scope === "exported" || scope === "unknown") {
            all(file, `${scope} module-scope change`);
            continue;
        }
        const tests = new Set([...touched].flatMap((id) => map.hits[id] ?? []));
        if (scope === "file")
            for (const s of spans)
                for (const test of map.hits[s.id] ?? [])
                    tests.add(test);
        for (const test of tests)
            run.add(test);
        notes.push(`${file}: ${touched.size} changed function(s)${scope === "file" ? " and a module-scope change" : ""}, ${tests.size} test file(s)`);
    }
    return { run: [...run].sort(), related: [], notes };
}
//# sourceMappingURL=python.js.map