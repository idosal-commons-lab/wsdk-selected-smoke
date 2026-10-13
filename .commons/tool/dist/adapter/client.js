export class ClientError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "ClientError";
    }
}
const CALL_ATTEMPTS = 8;
/** Connection-level failures before a response: the server never answered, or reset a reused keep-alive socket. */
const NOT_SENT = new Set(["ECONNREFUSED", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"]);
function transient(error, method) {
    if (!(error instanceof Error))
        return false;
    const cause = error.cause;
    const code = cause?.code ?? error.code;
    if (method === "GET")
        return error.name === "TypeError" || code !== undefined;
    return code !== undefined && NOT_SENT.has(code);
}
export class CoordinatorClient {
    baseUrl;
    token;
    fetchImpl;
    constructor(baseUrl, token, fetchImpl = fetch) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.fetchImpl = fetchImpl;
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }
    async call(method, path, body) {
        const headers = { accept: "application/json" };
        if (body !== undefined)
            headers["content-type"] = "application/json";
        if (this.token)
            headers.authorization = `Bearer ${this.token}`;
        let response;
        for (let attempt = 1;; attempt++) {
            try {
                response = await this.fetchImpl(this.baseUrl + path, {
                    method,
                    headers,
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
                break;
            }
            catch (error) {
                // A connection the server dropped (a keep-alive socket closed while the request went out, a server busy for
                // seconds): retried with backoff. Reads always; writes only when the request cannot have been processed.
                if (attempt >= CALL_ATTEMPTS || !transient(error, method))
                    throw error;
                await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 100 * 2 ** (attempt - 1))));
            }
        }
        const text = await response.text();
        let parsed = undefined;
        if (text) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = { error: text };
            }
        }
        if (!response.ok) {
            const message = parsed && typeof parsed === "object" && "error" in parsed
                ? String(parsed.error)
                : `${response.status} ${response.statusText}`;
            throw new ClientError(response.status, message);
        }
        return parsed;
    }
    createRepo(input) {
        return this.call("POST", "/api/repos", input);
    }
    getRepo(repoId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}`);
    }
    addTasks(repoId, tasks) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/tasks`, tasks);
    }
    listTasks(repoId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/tasks`);
    }
    plan(repoId) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/plan`);
    }
    briefMeta(repoId, taskId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/tasks/${encodeURIComponent(taskId)}/brief`);
    }
    setTaskBase(repoId, taskId, baseCommit) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/tasks/${encodeURIComponent(taskId)}/base`, { baseCommit });
    }
    claim(repoId, taskId, input) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/tasks/${encodeURIComponent(taskId)}/claim`, input);
    }
    submit(repoId, taskId, input) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/tasks/${encodeURIComponent(taskId)}/submit`, input);
    }
    delta(repoId, taskId, after) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/tasks/${encodeURIComponent(taskId)}/delta?after=${after}`);
    }
    abandon(repoId, taskId, reason = "") {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/tasks/${encodeURIComponent(taskId)}/abandon`, { reason });
    }
    taskStatus(repoId, taskId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/tasks/${encodeURIComponent(taskId)}`);
    }
    lease(repoId, executorId, max, affinity = false, speculate = false) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/executor/lease`, { executorId, max, ...(affinity ? { affinity: true } : {}), ...(speculate ? { speculate: true } : {}) });
    }
    setCandidate(repoId, batchId, executorId, commit) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/executor/lease/${encodeURIComponent(batchId)}/candidate`, { executorId, commit });
    }
    leaseState(repoId, batchId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/executor/lease/${encodeURIComponent(batchId)}`);
    }
    renewLease(repoId, batchId, executorId) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/executor/lease/${encodeURIComponent(batchId)}/renew`, { executorId });
    }
    settle(repoId, settlement) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/executor/settle`, settlement);
    }
    report(repoId, result) {
        return this.call("POST", `/api/repos/${encodeURIComponent(repoId)}/executor/report`, result);
    }
    events(repoId, after, limit = 100) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/events?after=${after}&limit=${limit}`);
    }
    landings(repoId, after = 0) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/landings?after=${after}`);
    }
    metrics(repoId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/metrics`);
    }
    unsettled(repoId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/unsettled`);
    }
    putVerdict(repoId, verdict) {
        return this.call("PUT", `/api/repos/${encodeURIComponent(repoId)}/verdicts`, verdict);
    }
    async getVerdict(repoId, key, checkId) {
        try {
            return await this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/verdicts/${encodeURIComponent(key)}/${encodeURIComponent(checkId)}`);
        }
        catch (error) {
            if (error instanceof ClientError && error.status === 404)
                return null;
            throw error;
        }
    }
    submission(repoId, submissionId) {
        return this.call("GET", `/api/repos/${encodeURIComponent(repoId)}/submissions/${encodeURIComponent(submissionId)}`);
    }
}
//# sourceMappingURL=client.js.map