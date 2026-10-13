// Launch one agent per task in print mode (Claude Code, Codex) or the deterministic fake, capture its
// transcript and usage, enforce a timeout, and never throw: every failure is an AgentRun with isError.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const PHASES = ["setup", "explore", "implement", "test", "integrate", "coordinate", "other", "think"];
export function emptyPhases() {
    return Object.fromEntries(PHASES.map((phase) => [phase, { calls: 0, ms: 0, input: 0, cachedInput: 0, cacheCreation: 0, output: 0 }]));
}
/** platform/ (from src/runner or dist/runner). */
export const PLATFORM_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/**
 * `node --import` resolves a bare specifier from the process cwd, and agents run inside worktrees that
 * have no `tsx`, so the loader is passed as the absolute URL of the platform's own copy.
 */
export const TSX_LOADER = (() => {
    try {
        return import.meta.resolve("tsx");
    }
    catch {
        return "tsx";
    }
})();
/** The fake agent script: the TypeScript source when running from src/, the compiled file from dist/. */
export const FAKE_AGENT_SCRIPT = (() => {
    const ts = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));
    return existsSync(ts) ? ts : fileURLToPath(new URL("./fake-agent.js", import.meta.url));
})();
/** Grace period between SIGINT and SIGKILL when an agent exceeds its timeout. */
export const KILL_GRACE_MS = 30_000;
/**
 * The `commons mcp` server command for one task. `repoId` is the coordinator repo id passed as `--repo`.
 * Uses `bin/commons.mjs` when the platform is built, else `tsx` over `src/cli.ts`.
 */
export function mcpCommandFor(taskId, worktree, repoId) {
    // Coordinator URL, repo id and host URL travel in the MCP server env (COMMONS_URL/COMMONS_REPO/COMMONS_HOST).
    void repoId;
    const tail = ["mcp", "--task", taskId, "--worktree", worktree];
    if (existsSync(join(PLATFORM_ROOT, "dist", "cli.js"))) {
        return { command: "node", args: [join(PLATFORM_ROOT, "bin", "commons.mjs"), ...tail] };
    }
    return { command: "node", args: ["--import", TSX_LOADER, join(PLATFORM_ROOT, "src", "cli.ts"), ...tail] };
}
/** Shell command for the Claude Code hook entry point (same binary as the MCP server). */
export function hookCommandFor() {
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    if (existsSync(join(PLATFORM_ROOT, "dist", "cli.js")))
        return `node ${q(join(PLATFORM_ROOT, "bin", "commons.mjs"))} hook`;
    return `node --import ${q(TSX_LOADER)} ${q(join(PLATFORM_ROOT, "src", "cli.ts"))} hook`;
}
/** Claude Code project settings that deliver deltas at tool boundaries and block Stop before submit. */
export function claudeHookSettings() {
    const command = hookCommandFor();
    const hook = { type: "command", command, timeout: 60 };
    return {
        hooks: {
            PostToolUse: [{ matcher: "Edit|Write|MultiEdit|Bash|NotebookEdit", hooks: [hook] }],
            UserPromptSubmit: [{ hooks: [hook] }],
            Stop: [{ hooks: [hook] }],
        },
    };
}
/** Claude Code `--mcp-config` document (also what the runner writes to `<worktree>/.mcp.json`). */
export function mcpConfigFor(spec) {
    // alwaysLoad: Claude Code defers MCP tool schemas behind a ToolSearch turn; this server's five tools load upfront
    // instead (about 1k tokens). Turning tool search off globally (ENABLE_TOOL_SEARCH=false) would also load every
    // deferred built-in tool's schema, about 22k tokens on every turn of every agent.
    const entry = { command: spec.command, args: spec.args, alwaysLoad: true };
    if (spec.env && Object.keys(spec.env).length > 0)
        entry.env = spec.env;
    return { mcpServers: { commons: entry } };
}
// ---- TOML for Codex `-c` overrides ---------------------------------------------------------------
/** JSON string escapes are a subset of TOML basic-string escapes, so JSON.stringify yields valid TOML. */
export function tomlString(s) {
    return JSON.stringify(s);
}
export function tomlArray(items) {
    return `[${items.map(tomlString).join(",")}]`;
}
export function tomlTable(entries) {
    return `{${Object.entries(entries)
        .map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)}=${tomlString(v)}`)
        .join(",")}}`;
}
/** Codex `-c` overrides that register the MCP server as `mcp_servers.commons`. */
export function codexMcpOverrides(spec) {
    const out = [
        "-c",
        `mcp_servers.commons.command=${tomlString(spec.command)}`,
        "-c",
        `mcp_servers.commons.args=${tomlArray(spec.args)}`,
    ];
    if (spec.env && Object.keys(spec.env).length > 0)
        out.push("-c", `mcp_servers.commons.env=${tomlTable(spec.env)}`);
    // codex exec runs with approval_policy "never"; MCP tools default to prompting, which would block every call.
    out.push("-c", 'mcp_servers.commons.default_tools_approval_mode="approve"', "-c", "mcp_servers.commons.required=true");
    return out;
}
// ---- command lines -------------------------------------------------------------------------------
export function claudeCommand(o, mcpConfigPath) {
    // The prompt goes through stdin, never argv: an agent's `pkill -f <word>` must not match other agents' command lines
    // (one did, on the test runner's name, and took the whole swarm down), and argv has a length limit.
    // Every arm is isolated the same way: only the MCP servers the runner configures (an empty set for arms without one),
    // and project-level settings only, so the machine's user-level MCP servers, plugins and hooks never reach an agent.
    const args = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--setting-sources", "project"];
    if (mcpConfigPath)
        args.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
    if (o.settingsPath)
        args.push("--settings", o.settingsPath);
    if (o.model)
        args.push("--model", o.model);
    if (o.maxTurns !== undefined)
        args.push("--max-turns", String(o.maxTurns));
    if (o.maxBudgetUsd !== undefined)
        args.push("--max-budget-usd", String(o.maxBudgetUsd));
    if (o.resumeSessionId)
        args.push("--resume", o.resumeSessionId);
    return args;
}
export function codexCommand(o, lastMessagePath) {
    // --ignore-user-config keeps the user's own MCP servers/apps out of the run (they confused the agent and
    // required approvals); the model then comes from --model, COMMONS_CODEX_MODEL, or Codex's default.
    const args = ["codex", "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-s", "workspace-write", "-C", o.cwd, "-o", lastMessagePath];
    const codexModel = o.model ?? process.env.COMMONS_CODEX_MODEL;
    if (codexModel && !o.model)
        args.push("-m", codexModel);
    if (o.model)
        args.push("-m", o.model);
    if (o.mcp)
        args.push(...codexMcpOverrides(o.mcp));
    const effort = process.env.COMMONS_CODEX_EFFORT;
    if (effort)
        args.push("-c", `model_reasoning_effort=${tomlString(effort)}`);
    args.push("-"); // the prompt arrives over stdin (see claudeCommand)
    return args;
}
export function fakeCommand() {
    return ["node", "--import", TSX_LOADER, FAKE_AGENT_SCRIPT];
}
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const optNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "Task", "TodoRead", "TodoWrite"]);
const IMPLEMENT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Best-effort shell classification, shared by Claude Bash and Codex command_execution items. */
/** Replace every heredoc body (data, not commands) with a marker, keeping the commands before and after it. */
export function stripHeredocs(command) {
    const lines = command.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
        out.push(m ? `${line} heredoc` : line);
        if (!m)
            continue;
        const end = m[2];
        let j = i + 1;
        while (j < lines.length && lines[j].trim() !== end)
            j++;
        i = j; // skip the body and the terminator
    }
    return out.join("\n");
}
export function commandPhase(command) {
    // Compound shell commands are common ("cd src; cat a; sed -n 1,20p b", "git add -A && git commit"). Score each
    // simple command by its first verb (after cd/env/sudo prefixes) and let the most consequential phase win:
    // test > implement > integrate > explore.
    const parts = stripHeredocs(command)
        .split(/\|\||&&|;|\||\n/)
        .map((p) => p.trim())
        .filter(Boolean);
    const scores = { setup: 0, explore: 0, implement: 0, test: 0, integrate: 0, coordinate: 0, other: 0, think: 0 };
    for (const part of parts) {
        const words = part.replace(/^(cd\s+\S+|env(\s+\w+=\S*)*|sudo|time|\w+=\S*)\s+/g, "").split(/\s+/);
        const verb = (words[0] ?? "").replace(/^.*\//, "");
        const rest = words.slice(1).join(" ");
        const redirect = /(^|\s)>{1,2}\s*\S/.test(part);
        if (/^(vitest|jest|mocha|ava|tsc|eslint|pytest|cargo|go)$/.test(verb) || (/^(npx|pnpm|yarn|npm|bun|node)$/.test(verb) && /\b(vitest|jest|mocha|ava|tsc|eslint|test|check|typecheck|lint)\b/.test(rest)))
            scores.test++;
        else if (verb === "git")
            scores.integrate++;
        else if (/^(sed|perl)$/.test(verb) && /\s-[a-zA-Z]*[iI]\b|\s-pi\b/.test(part))
            scores.implement++;
        else if (/^(python3?|node|ruby|php)$/.test(verb) && (words[1] === "-" || words[1] === "-e" || words[1] === "-c" || /heredoc/.test(part)))
            scores.implement++;
        else if (/^(tee|touch|mkdir|cp|mv|rm|patch|applypatch|truncate|install)$/.test(verb) || redirect)
            scores.implement++;
        else if (/^(cat|sed|head|tail|less|more|grep|rg|ag|ack|ls|find|fd|wc|tree|stat|file|diff|awk|cut|sort|uniq|pwd|echo|printf|type|which|jq|realpath|basename|dirname)$/.test(verb))
            scores.explore++;
        else
            scores.other++;
    }
    for (const phase of ["test", "implement", "integrate", "explore"])
        if (scores[phase] > 0)
            return phase;
    return "other";
}
export function toolPhase(name, input) {
    if (name.startsWith("mcp__"))
        return "coordinate";
    if (EXPLORE_TOOLS.has(name))
        return "explore";
    if (IMPLEMENT_TOOLS.has(name))
        return "implement";
    if (name === "Bash" && isObject(input) && typeof input.command === "string")
        return commandPhase(input.command);
    return "other";
}
/** Feed complete NDJSON lines with their local receipt times, rather than provider timestamps. */
export class AgentStreamParser {
    kind;
    phases = emptyPhases();
    submitWaitMs = 0;
    result = null;
    previousAt;
    pending = new Map();
    /** The last assistant message seen: Claude Code emits one event per content block, all carrying the same usage. */
    lastMessage = null;
    /** The first assistant message of a run carries the prompt (and brief) ingestion: it is the "setup" phase whatever it calls. */
    firstMessage = true;
    constructor(kind, startedAt) {
        this.kind = kind;
        this.previousAt = startedAt;
    }
    receive(line, receivedAt) {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            return;
        }
        if (!isObject(event))
            return;
        if (this.kind === "claude")
            this.claudeEvent(event, receivedAt);
        else
            this.codexEvent(event, receivedAt);
        this.previousAt = receivedAt;
    }
    start(id, phase, receivedAt, submit = false) {
        if (typeof id === "string" && this.pending.has(id))
            return;
        this.phases[phase].calls++;
        if (typeof id === "string")
            this.pending.set(id, { phase, startedAt: receivedAt, submit });
    }
    finish(id, receivedAt) {
        if (typeof id !== "string")
            return;
        const tool = this.pending.get(id);
        if (!tool)
            return;
        const ms = Math.max(0, receivedAt - tool.startedAt);
        this.phases[tool.phase].ms += ms;
        if (tool.submit)
            this.submitWaitMs += ms;
        this.pending.delete(id);
    }
    claudeEvent(event, receivedAt) {
        if (event.type === "result") {
            this.result = event;
            return;
        }
        const message = isObject(event.message) ? event.message : {};
        const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
        if (event.type === "user") {
            for (const block of content)
                if (block.type === "tool_result")
                    this.finish(block.tool_use_id, receivedAt);
        }
        else if (event.type === "assistant") {
            const tools = content.filter((block) => block.type === "tool_use");
            const id = typeof message.id === "string" ? message.id : "";
            const last = this.lastMessage;
            const sameMessage = !!(last && id && last.id === id);
            if (!sameMessage && last)
                this.firstMessage = false;
            const phase = this.firstMessage ? "setup" : tools.length ? toolPhase(String(tools[0].name), tools[0].input) : "think";
            if (sameMessage) {
                // Another block of the same message: usage was already counted. If the first block was a thinking/text
                // block and this one is the tool call, the message belongs to the tool's phase, not to "think".
                if (tools.length && last.phase === "think" && !this.firstMessage) {
                    const from = this.phases.think;
                    const to = this.phases[phase];
                    for (const k of ["input", "cachedInput", "cacheCreation", "output"]) {
                        from[k] -= last.usage[k];
                        to[k] += last.usage[k];
                    }
                    if (last.thinkCall) {
                        from.calls--;
                        last.thinkCall = false;
                    }
                    last.phase = phase;
                }
            }
            else {
                const usage = isObject(message.usage) ? message.usage : {};
                const counted = { calls: 0, ms: 0, input: num(usage.input_tokens), cachedInput: num(usage.cache_read_input_tokens), cacheCreation: num(usage.cache_creation_input_tokens), output: num(usage.output_tokens) };
                const bucket = this.phases[phase];
                bucket.input += counted.input;
                bucket.cachedInput += counted.cachedInput;
                bucket.cacheCreation += counted.cacheCreation;
                bucket.output += counted.output;
                if (tools.length === 0 || phase === "setup") {
                    bucket.calls++;
                    bucket.ms += Math.max(0, receivedAt - this.previousAt);
                }
                this.lastMessage = { id, phase, usage: counted, thinkCall: tools.length === 0 && phase !== "setup" };
            }
            for (const tool of tools) {
                const name = String(tool.name);
                this.start(tool.id, toolPhase(name, tool.input), receivedAt, name.startsWith("mcp__") && name.endsWith("submit"));
            }
        }
    }
    codexEvent(event, receivedAt) {
        if (event.type !== "item.started" && event.type !== "item.completed")
            return;
        const item = isObject(event.item) ? event.item : {};
        if (event.type === "item.completed" && typeof item.id === "string" && this.pending.has(item.id)) {
            this.finish(item.id, receivedAt);
            return;
        }
        let phase;
        if (item.type === "command_execution" && typeof item.command === "string")
            phase = commandPhase(item.command);
        else if (item.type === "file_change")
            phase = "implement";
        else if (item.type === "mcp_tool_call")
            phase = "coordinate";
        else
            return; // Turn-level usage cannot reliably be attributed to individual Codex items.
        const submit = item.type === "mcp_tool_call" && typeof item.tool === "string" && item.tool.endsWith("submit");
        this.start(item.id, phase, receivedAt, submit);
        if (event.type === "item.completed")
            this.finish(item.id, receivedAt);
    }
}
function resultObject(v) {
    if (Array.isArray(v)) {
        const result = v.find((x) => isObject(x) && x.type === "result");
        if (isObject(result))
            return result;
        const last = v[v.length - 1];
        return isObject(last) ? last : null;
    }
    return isObject(v) ? v : null;
}
/** The single JSON object `claude -p --output-format json` prints (tolerates stray lines around it). */
export function parseClaudeOutput(stdout) {
    const text = stdout.trim();
    if (!text)
        return null;
    try {
        const whole = resultObject(JSON.parse(text));
        if (whole)
            return whole;
    }
    catch {
        // fall through
    }
    let last = null;
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{"))
            continue;
        try {
            const v = JSON.parse(t);
            if (isObject(v)) {
                if (v.type === "result")
                    return v;
                last = v;
            }
        }
        catch {
            // not a JSON line
        }
    }
    if (last)
        return last;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            return resultObject(JSON.parse(text.slice(start, end + 1)));
        }
        catch {
            // give up
        }
    }
    return null;
}
export function claudeUsage(stdout) {
    const r = parseClaudeOutput(stdout);
    if (!r)
        return null;
    const usage = isObject(r.usage) ? r.usage : {};
    const out = {
        tokens: {
            input: num(usage.input_tokens),
            cachedInput: num(usage.cache_read_input_tokens),
            cacheCreation: num(usage.cache_creation_input_tokens),
            output: num(usage.output_tokens),
        },
        isError: r.is_error === true,
    };
    const cost = optNum(r.total_cost_usd);
    if (cost !== undefined)
        out.costUsd = cost;
    const turns = optNum(r.num_turns);
    if (turns !== undefined)
        out.turns = turns;
    const duration = optNum(r.duration_ms);
    if (duration !== undefined)
        out.durationMs = duration;
    if (typeof r.result === "string")
        out.resultText = r.result;
    else if (r.subtype && typeof r.subtype === "string" && r.subtype !== "success")
        out.resultText = r.subtype;
    if (typeof r.api_error === "string" && r.api_error)
        out.apiError = r.api_error;
    return out;
}
/**
 * When the account's usage limit, not the agent's work, ended this run: the reason, else null. Such a run measures
 * nothing, and every agent launched after it would end the same way.
 */
export function usageLimitOf(run) {
    if (run.apiError === "usage_limit_reached" || run.apiError === "rate_limit_exceeded")
        return run.resultText?.trim() || run.apiError;
    if (run.isError && /\b(usage limit|hit your \w+ limit|rate limit reached)\b/i.test(run.resultText ?? ""))
        return run.resultText.trim();
    return null;
}
/** A run stopped because the agents' account ran out of usage; its report would not be a measurement. */
export class UsageLimitError extends Error {
    reason;
    arm;
    constructor(reason, arm) {
        super(`agent usage limit reached in the ${arm} arm (${reason}); the run stopped launching agents and is not a measurement`);
        this.reason = reason;
        this.arm = arm;
        this.name = "UsageLimitError";
    }
}
/**
 * Sum `turn.completed` usage over the JSONL stream. Codex reports `input_tokens` inclusive of
 * `cached_input_tokens`, so the uncached share is their difference (matching Claude's `input_tokens`).
 */
export function codexUsage(stdout) {
    const out = { tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 }, turns: 0, isError: false };
    for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{"))
            continue;
        let ev;
        try {
            ev = JSON.parse(t);
        }
        catch {
            continue;
        }
        if (!isObject(ev))
            continue;
        const type = ev.type;
        if (type === "turn.completed") {
            const usage = isObject(ev.usage) ? ev.usage : {};
            const input = num(usage.input_tokens);
            const cached = Math.min(input, num(usage.cached_input_tokens));
            out.tokens.input += input - cached;
            out.tokens.cachedInput += cached;
            out.tokens.output += num(usage.output_tokens);
            out.turns++;
        }
        else if (type === "item.completed") {
            const item = isObject(ev.item) ? ev.item : null;
            if (item && item.type === "agent_message" && typeof item.text === "string")
                out.resultText = item.text;
        }
        else if (type === "turn.failed" || type === "error") {
            out.isError = true;
            const error = isObject(ev.error) ? ev.error : ev;
            if (typeof error.message === "string")
                out.errorText = error.message;
        }
    }
    return out;
}
/** The agent's final status line (`LANDED <sha>` / `NOT LANDED: ...` / a detached agent's `SUBMITTED <sha>`) when it printed one. */
export function statusLine(text) {
    if (!text)
        return undefined;
    const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (/^(?:LANDED\b|NOT LANDED\b|SUBMITTED\b)/.test(line))
            return line;
    }
    return undefined;
}
function spawnCollect(argv, opts) {
    return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        const stdout = [];
        const stderr = [];
        let partial = "";
        let lastReceiptAt = 0;
        const finish = (r) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killTimer);
            if (partial)
                opts.onLine?.(partial, lastReceiptAt);
            resolve({ ...r, stdout: stdout.join(""), stderr: stderr.join(""), timedOut });
        };
        let child;
        try {
            child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"], detached: true });
            if (opts.stdin !== undefined && child.stdin) {
                child.stdin.on("error", () => undefined);
                child.stdin.end(opts.stdin);
            }
        }
        catch (error) {
            resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, error: error });
            return;
        }
        const signalGroup = (sig) => {
            try {
                if (child.pid)
                    process.kill(-child.pid, sig);
                else
                    child.kill(sig);
            }
            catch {
                try {
                    child.kill(sig);
                }
                catch {
                    // already gone
                }
            }
        };
        let killTimer;
        const timer = setTimeout(() => {
            timedOut = true;
            signalGroup("SIGINT");
            killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
        }, opts.timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (d) => {
            stdout.push(d);
            lastReceiptAt = Date.now();
            if (opts.streamPath)
                appendFileSync(opts.streamPath, d);
            if (!opts.onLine)
                return;
            partial += d;
            let end;
            while ((end = partial.indexOf("\n")) >= 0) {
                opts.onLine(partial.slice(0, end).replace(/\r$/, ""), lastReceiptAt);
                partial = partial.slice(end + 1);
            }
        });
        child.stderr?.on("data", (d) => stderr.push(d.toString()));
        child.on("error", (error) => finish({ code: null, signal: null, error }));
        child.on("close", (code, signal) => finish({ code, signal }));
        child.on("exit", (code, signal) => {
            // "close" normally follows; if a grandchild keeps the pipes open, settle anyway.
            setTimeout(() => finish({ code, signal }), 2000).unref();
        });
    });
}
// ---- runAgent ------------------------------------------------------------------------------------
export async function runAgent(o) {
    mkdirSync(o.logDir, { recursive: true });
    const base = join(o.logDir, o.logName ?? o.taskId);
    writeFileSync(`${base}.prompt.md`, o.prompt);
    const env = {};
    for (const [k, v] of Object.entries(process.env))
        if (v !== undefined)
            env[k] = v;
    Object.assign(env, o.env ?? {});
    let argv;
    let transcriptPath;
    let lastMessagePath;
    if (o.kind === "claude") {
        let mcpConfigPath = o.mcpConfigPath;
        if (!mcpConfigPath) {
            mcpConfigPath = `${base}.mcp.json`;
            writeFileSync(mcpConfigPath, JSON.stringify(o.mcp ? mcpConfigFor(o.mcp) : { mcpServers: {} }, null, 2) + "\n");
        }
        argv = claudeCommand(o, mcpConfigPath);
        env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
        transcriptPath = `${base}.json`;
    }
    else if (o.kind === "codex") {
        lastMessagePath = `${base}.last.md`;
        argv = codexCommand(o, lastMessagePath);
        transcriptPath = `${base}.jsonl`;
    }
    else {
        argv = fakeCommand();
        env.COMMONS_PROMPT_PATH = `${base}.prompt.md`;
        transcriptPath = `${base}.stdout.log`;
    }
    const stderrPath = `${base}.stderr.log`;
    const streamPath = o.kind === "claude" ? `${base}.stream.jsonl` : undefined;
    if (streamPath)
        writeFileSync(streamPath, "");
    const command = argv.map((a) => (a === o.prompt ? "<prompt>" : a));
    const startedAt = Date.now();
    const stream = o.kind === "fake" ? null : new AgentStreamParser(o.kind, startedAt);
    const r = await spawnCollect(argv, { cwd: o.cwd, env, timeoutMs: o.timeoutMs, streamPath, onLine: (line, at) => stream?.receive(line, at), ...(o.kind === "claude" || o.kind === "codex" ? { stdin: o.prompt } : {}) });
    const durationMs = Date.now() - startedAt;
    if (o.kind === "claude") {
        writeFileSync(transcriptPath, JSON.stringify(stream.result, null, 2) + "\n");
    }
    else
        writeFileSync(transcriptPath, r.stdout);
    writeFileSync(stderrPath, r.stderr + (r.error ? `\n[runner] spawn failed: ${r.error.message}\n` : ""));
    const run = {
        kind: o.kind,
        taskId: o.taskId,
        command,
        startedAt,
        durationMs,
        exitCode: r.code,
        signal: r.signal,
        timedOut: r.timedOut,
        isError: r.error !== undefined || r.timedOut || r.code !== 0,
        tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 },
        phases: stream?.phases ?? emptyPhases(),
        submitWaitMs: stream?.submitWaitMs ?? 0,
        transcriptPath,
        ...(streamPath ? { streamPath } : {}),
        stderrPath,
    };
    if (r.error)
        run.resultText = `spawn failed: ${r.error.message}`;
    if (o.kind === "claude") {
        const usage = stream.result ? claudeUsage(JSON.stringify(stream.result)) : null;
        if (usage) {
            run.tokens = usage.tokens;
            if (usage.durationMs !== undefined)
                run.durationMs = usage.durationMs;
            if (usage.costUsd !== undefined)
                run.costUsd = usage.costUsd;
            if (usage.turns !== undefined)
                run.turns = usage.turns;
            if (usage.resultText !== undefined)
                run.resultText = usage.resultText;
            if (usage.isError)
                run.isError = true;
            if (usage.apiError)
                run.apiError = usage.apiError;
            const sessionId = stream.result?.session_id;
            if (typeof sessionId === "string" && sessionId)
                run.sessionId = sessionId;
        }
        else if (!run.resultText) {
            run.resultText = r.stderr.trim().split(/\r?\n/).slice(-5).join("\n") || "no JSON result on stdout";
            run.isError = true;
        }
    }
    else if (o.kind === "codex") {
        const usage = codexUsage(r.stdout);
        run.tokens = usage.tokens;
        run.turns = usage.turns;
        let text = usage.resultText;
        if (lastMessagePath && existsSync(lastMessagePath)) {
            try {
                const last = readFileSync(lastMessagePath, "utf8").trim();
                if (last)
                    text = last;
            }
            catch {
                // keep the streamed message
            }
        }
        if (text !== undefined)
            run.resultText = text;
        else if (usage.errorText)
            run.resultText = usage.errorText;
        if (usage.isError)
            run.isError = true;
    }
    else if (!r.error) {
        run.resultText = r.stdout.trim();
    }
    return run;
}
//# sourceMappingURL=agents.js.map