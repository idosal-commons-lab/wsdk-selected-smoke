// Web-standard HTTP router over the coordinator. Runs on Node (node-server.ts) and in workerd.
import { z } from "zod";
import { CoordinatorError } from "./coordinator.js";
// ---- schemas -----------------------------------------------------------------
const ScopeSchema = z.object({ path: z.string().min(1), symbols: z.array(z.string()).optional() });
const RenewSchema = z.object({ executorId: z.string().min(1) });
const VerdictInputSchema = z.object({
    key: z.string().min(1),
    checkId: z.string().min(1),
    passed: z.boolean(),
    failedTests: z.array(z.string()),
    durationMs: z.number().nonnegative(),
});
const RepoInputSchema = z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    mainCommit: z.string().min(1),
    testCommand: z.string(),
    relatedTestCommand: z.string().optional(),
    privacy: z.enum(["plain", "tokens"]).optional(),
    admission: z.enum(["dependencies", "overlaps", "pipeline", "declared", "none"]).optional(),
    window: z.number().int().min(1).optional(),
    windowPolicy: z.enum(["fixed", "adaptive"]).optional(),
    windowMax: z.number().int().min(1).optional(),
});
const TaskInputSchema = z.object({
    id: z.string().min(1).optional(),
    title: z.string(),
    body: z.string(),
    kind: z.string().optional(),
    writes: z.array(ScopeSchema).optional(),
    reads: z.array(ScopeSchema).optional(),
    dependsOn: z.array(z.string()).optional(),
});
const TasksBodySchema = z.array(TaskInputSchema);
const ClaimSchema = z.object({ writes: z.array(ScopeSchema).default([]), reads: z.array(ScopeSchema).default([]) });
const TaskBaseSchema = z.object({ baseCommit: z.string().min(1) });
const SubmitSchema = z.object({ commit: z.string().min(1), parentMain: z.string().min(1), summary: z.string().default("") });
const VerdictSchema = z.object({
    passed: z.boolean(),
    failedTests: z.array(z.string()).default([]),
    conflicts: z.array(z.object({ path: z.string(), hunks: z.number().int().optional() })).default([]),
    excerpt: z.string().default(""),
    checkTreeSha: z.string().optional(),
    cached: z.boolean().default(false),
    durationMs: z.number().default(0),
    onlyFailsCombined: z.array(z.string()).optional(),
    transferred: z.boolean().optional(),
    preVerified: z.boolean().optional(),
    optimistic: z.boolean().optional(),
    verified: z.boolean().optional(),
    reverted: z.object({ commit: z.string().nullable(), prevMain: z.string(), landed: z.string() }).optional(),
});
const FootprintSchema = z.object({ changed: z.array(z.string()), changedSymbols: z.record(z.string(), z.array(z.string())).optional(), closure: z.array(z.string()).nullable() });
const ChangeSummarySchema = z.object({
    path: z.string(),
    status: z.enum(["A", "M", "D"]),
    symbolsChanged: z.array(z.string()).default([]),
    contractChanges: z.array(z.object({ symbol: z.string(), before: z.string(), after: z.string() })).default([]),
});
const BatchResultSchema = z.object({
    batchId: z.string().min(1),
    toMain: z.string().min(1),
    results: z
        .array(z.object({
        submissionId: z.string().min(1),
        status: z.enum(["landed", "bounced"]),
        verdict: VerdictSchema,
        toMain: z.string().optional(),
        changed: z.array(ChangeSummarySchema).optional(),
        footprint: FootprintSchema.optional(),
    }))
        .default([]),
    requeue: z.array(z.string()).default([]),
    rebasedFrom: z.string().min(1).optional(),
    defer: z.array(z.string()).optional(),
    deferMs: z.number().int().positive().optional(),
});
const LeaseSchema = z.object({ executorId: z.string().min(1), max: z.number().int().positive().default(10), affinity: z.boolean().optional(), speculate: z.boolean().optional() });
const SettlementSchema = z.discriminatedUnion("outcome", [
    z.object({ submissionId: z.string().min(1), executorId: z.string().min(1), outcome: z.literal("verified") }),
    z.object({
        submissionId: z.string().min(1),
        executorId: z.string().min(1),
        outcome: z.literal("reverted"),
        verdict: VerdictSchema,
        revert: z.object({ commit: z.string().min(1), fromMain: z.string().min(1), changed: z.array(ChangeSummarySchema).default([]) }).nullable(),
        prevMain: z.string().min(1),
        landed: z.string().min(1),
    }),
]);
const CandidateSchema = z.object({ executorId: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/) });
// ---- helpers -----------------------------------------------------------------
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "HttpError";
    }
}
const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
};
function json(data, status = 200) {
    return new Response(JSON.stringify(data === undefined ? null : data), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
    });
}
function parse(schema, data) {
    const result = schema.safeParse(data);
    if (!result.success) {
        const detail = result.error.issues
            .map((issue) => (issue.path.length ? `${issue.path.map(String).join(".")}: ${issue.message}` : issue.message))
            .join("; ");
        throw new HttpError(400, `invalid body: ${detail}`);
    }
    return result.data;
}
async function readJson(request) {
    let text;
    try {
        text = await request.text();
    }
    catch {
        throw new HttpError(400, "unreadable body");
    }
    if (text.trim() === "")
        throw new HttpError(400, "missing JSON body");
    try {
        return JSON.parse(text);
    }
    catch {
        throw new HttpError(400, "invalid JSON body");
    }
}
function intParam(url, name, fallback, max) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "")
        return fallback;
    if (!/^\d+$/.test(raw))
        throw new HttpError(400, `query parameter ${name} must be a non-negative integer`);
    const value = Number(raw);
    return max !== undefined ? Math.min(value, max) : value;
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
function route(method, pattern, handler) {
    return { method, segments: pattern.split("/").filter(Boolean), handler };
}
function match(segments, path) {
    if (segments.length !== path.length)
        return null;
    const params = {};
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const part = path[i];
        if (seg.startsWith(":"))
            params[seg.slice(1)] = part;
        else if (seg !== part)
            return null;
    }
    return params;
}
// ---- api ---------------------------------------------------------------------
export function createApi(coordinator, opts = {}) {
    const c = coordinator;
    const routes = [
        route("POST", "/api/repos", async ({ request }) => c.createRepo(parse(RepoInputSchema, await readJson(request)))),
        route("GET", "/api/repos/:r", ({ params }) => c.getRepo(params.r)),
        route("POST", "/api/repos/:r/tasks", async ({ params, request }) => c.addTasks(params.r, parse(TasksBodySchema, await readJson(request)))),
        route("GET", "/api/repos/:r/tasks", ({ params }) => c.listTasks(params.r)),
        route("POST", "/api/repos/:r/plan", ({ params }) => c.plan(params.r)),
        route("GET", "/api/repos/:r/tasks/:t", ({ params }) => c.taskStatus(params.r, params.t)),
        route("GET", "/api/repos/:r/tasks/:t/brief", ({ params }) => c.briefMeta(params.r, params.t)),
        route("POST", "/api/repos/:r/tasks/:t/base", async ({ params, request }) => c.setTaskBase(params.r, params.t, parse(TaskBaseSchema, await readJson(request)).baseCommit)),
        route("POST", "/api/repos/:r/tasks/:t/claim", async ({ params, request }) => c.claim(params.r, params.t, parse(ClaimSchema, await readJson(request)))),
        route("POST", "/api/repos/:r/tasks/:t/submit", async ({ params, request }) => c.submit(params.r, params.t, parse(SubmitSchema, await readJson(request)))),
        route("POST", "/api/repos/:r/tasks/:t/abandon", async ({ params, request }) => {
            const text = (await request.text()).trim();
            let body = {};
            if (text) {
                try {
                    body = JSON.parse(text);
                }
                catch {
                    throw new HttpError(400, "invalid JSON body");
                }
            }
            const reason = body && typeof body === "object" && "reason" in body ? String(body.reason ?? "") : "";
            return c.abandon(params.r, params.t, reason);
        }),
        route("GET", "/api/repos/:r/tasks/:t/delta", ({ params, url }) => c.delta(params.r, params.t, intParam(url, "after", 0))),
        route("POST", "/api/repos/:r/executor/lease", async ({ params, request }) => {
            const body = parse(LeaseSchema, await readJson(request));
            return c.lease(params.r, body.executorId, body.max, { ...(body.affinity ? { affinity: true } : {}), ...(body.speculate ? { speculate: true } : {}) });
        }),
        route("POST", "/api/repos/:r/executor/lease/:b/candidate", async ({ params, request }) => {
            const body = parse(CandidateSchema, await readJson(request));
            return c.setCandidate(params.r, params.b, body.executorId, body.commit);
        }),
        route("GET", "/api/repos/:r/executor/lease/:b", ({ params }) => c.leaseState(params.r, params.b)),
        route("POST", "/api/repos/:r/executor/lease/:b/renew", async ({ params, request }) => {
            const body = parse(RenewSchema, await readJson(request));
            return c.renewLease(params.r, params.b, body.executorId);
        }),
        route("POST", "/api/repos/:r/executor/settle", async ({ params, request }) => {
            c.settle(params.r, parse(SettlementSchema, await readJson(request)));
            return { ok: true };
        }),
        route("POST", "/api/repos/:r/executor/report", async ({ params, request }) => {
            c.report(params.r, parse(BatchResultSchema, await readJson(request)));
            return { ok: true };
        }),
        route("GET", "/api/repos/:r/events", ({ params, url }) => c.events(params.r, intParam(url, "after", 0), intParam(url, "limit", 100, 1000))),
        route("GET", "/api/repos/:r/metrics", ({ params }) => c.metrics(params.r)),
        route("GET", "/api/repos/:r/unsettled", ({ params }) => c.unsettled(params.r)),
        route("GET", "/api/repos/:r/landings", ({ params, url }) => c.landings(params.r, intParam(url, "after", 0))),
        route("GET", "/api/repos/:r/submissions/:s", ({ params }) => c.getSubmission(params.r, params.s)),
        route("PUT", "/api/repos/:r/verdicts", async ({ params, request }) => c.putVerdict(params.r, parse(VerdictInputSchema, await readJson(request)))),
        route("GET", "/api/repos/:r/verdicts/:k/:c", ({ params }) => {
            const verdict = c.getVerdict(params.r, params.k, params.c);
            if (!verdict)
                throw new HttpError(404, "no verdict for this key");
            return verdict;
        }),
    ];
    return async (request) => {
        try {
            if (request.method === "OPTIONS")
                return new Response(null, { status: 204, headers: CORS_HEADERS });
            const url = new URL(request.url);
            let path;
            try {
                path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
            }
            catch {
                throw new HttpError(400, "malformed path");
            }
            if (path[0] !== "api")
                throw new HttpError(404, "not found");
            if (opts.token !== undefined) {
                const header = request.headers.get("authorization") ?? "";
                const m = /^Bearer\s+(.+)$/i.exec(header);
                if (!m || !constantTimeEqual(m[1].trim(), opts.token))
                    throw new HttpError(401, "unauthorized");
            }
            const allowed = [];
            for (const r of routes) {
                const params = match(r.segments, path);
                if (!params)
                    continue;
                if (r.method !== request.method) {
                    allowed.push(r.method);
                    continue;
                }
                const result = await r.handler({ params, url, request });
                return json(result);
            }
            if (allowed.length > 0) {
                return new Response(JSON.stringify({ error: "method not allowed" }), {
                    status: 405,
                    headers: { "content-type": "application/json; charset=utf-8", allow: allowed.join(", "), ...CORS_HEADERS },
                });
            }
            throw new HttpError(404, "not found");
        }
        catch (err) {
            if (err instanceof HttpError || err instanceof CoordinatorError)
                return json({ error: err.message }, err.status);
            const message = err instanceof Error ? err.message : String(err);
            return json({ error: message }, 500);
        }
    };
}
//# sourceMappingURL=api.js.map