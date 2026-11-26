import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BridgeEnv,
  bridgeWorker,
  createDebouncer,
  createWebhookHandler,
  createWorkflowDispatcher,
  guardWebhookSignature,
  verifyWebhookSignature,
  type WorkerExecutionContext,
} from "../../src/bridge/index.js";
import defaultBridgeWorker from "../../src/bridge/worker.js";

const WEBHOOK_SECRET = "bridge-test-secret";
const DISPATCH_TOKEN = "ghs_test_dispatch_token";

interface ThreadPayloadOverrides {
  action?: unknown;
  repository?: unknown;
  pull_request?: unknown;
}

function createThreadPayload(overrides: ThreadPayloadOverrides = {}): Record<string, unknown> {
  return {
    action: "resolved",
    repository: {
      full_name: "octocat/hello-world",
      default_branch: "main",
    },
    pull_request: {
      number: 42,
      head: {
        sha: "abcdef1234567890",
      },
    },
    ...overrides,
  };
}

function signBody(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function createSignedRequest(
  body: string,
  options: {
    method?: string;
    event?: string | null;
    signature?: string | null;
    secret?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.event !== null) {
    headers.set("X-GitHub-Event", options.event ?? "pull_request_review_thread");
  }
  if (options.signature !== null) {
    headers.set("X-Hub-Signature-256", options.signature ?? signBody(body, options.secret));
  }
  const method = options.method ?? "POST";
  return new Request("https://bridge.example.test/webhook", {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

function createEnv(overrides: Partial<BridgeEnv> = {}): BridgeEnv {
  return {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_DISPATCH_TOKEN: DISPATCH_TOKEN,
    ...overrides,
  };
}

function createExecutionContext(): {
  ctx: WorkerExecutionContext;
  waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
} {
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
  return {
    ctx: { waitUntil },
    waitUntil,
  };
}

describe("bridge index re-exports", () => {
  it("exports signature, debouncer, and worker helpers", () => {
    expect(typeof verifyWebhookSignature).toBe("function");
    expect(typeof guardWebhookSignature).toBe("function");
    expect(typeof createDebouncer).toBe("function");
    expect(typeof createWorkflowDispatcher).toBe("function");
    expect(typeof createWebhookHandler).toBe("function");
    expect(typeof bridgeWorker.fetch).toBe("function");
    expect(defaultBridgeWorker).toBe(bridgeWorker);
  });
});

describe("createWorkflowDispatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts workflow_dispatch with required headers and pull_request_number input", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const dispatch = createWorkflowDispatcher({
      token: DISPATCH_TOKEN,
      workflowId: "merge-verdict.yml",
      fetch: fetchMock,
    });

    await dispatch({
      repository: "octocat/hello-world",
      prNumber: 42,
      headSha: "sha-1",
      defaultBranch: "main",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/octocat/hello-world/actions/workflows/merge-verdict.yml/dispatches",
    );
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${DISPATCH_TOKEN}`);
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(headers.get("User-Agent")).toBe("merge-verdict-bridge");
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "main",
      inputs: {
        pull_request_number: "42",
      },
    });
  });

  it("throws on non-2xx GitHub API responses without exposing the token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Workflow does not have workflow_dispatch", { status: 422 }));
    const dispatch = createWorkflowDispatcher({
      token: DISPATCH_TOKEN,
      fetch: fetchMock,
    });

    const promise = dispatch({
      repository: "octocat/hello-world",
      prNumber: 42,
      headSha: "sha-1",
      defaultBranch: "main",
    });

    await expect(promise).rejects.toThrow(/422/);
    await expect(promise).rejects.not.toThrow(DISPATCH_TOKEN);
  });

  it("validates dispatcher configuration and dispatch inputs", async () => {
    expect(() => createWorkflowDispatcher({ token: "" })).toThrow();
    expect(() =>
      createWorkflowDispatcher({ token: DISPATCH_TOKEN, workflowId: "bad/id.yml" }),
    ).toThrow();

    const dispatch = createWorkflowDispatcher({
      token: DISPATCH_TOKEN,
      fetch: vi.fn<typeof fetch>(),
    });
    await expect(
      dispatch({
        repository: "invalid-repo",
        prNumber: 42,
        headSha: "sha-1",
        defaultBranch: "main",
      }),
    ).rejects.toThrow();
    await expect(
      dispatch({
        repository: "octocat/hello-world",
        prNumber: 0,
        headSha: "sha-1",
        defaultBranch: "main",
      }),
    ).rejects.toThrow();
    await expect(
      dispatch({
        repository: "octocat/hello-world",
        prNumber: 42,
        headSha: "sha-1",
        defaultBranch: "",
      }),
    ).rejects.toThrow();
    expect(() =>
      createWebhookHandler({
        webhookSecret: WEBHOOK_SECRET,
        windowMs: 25001,
        dispatch: async () => {},
      }),
    ).toThrow(RangeError);
  });
});

describe("bridgeWorker webhook handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["GET", "PUT", "DELETE", "PATCH"])("returns 405 for %s requests", async (method) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const request = createSignedRequest("", { method });

    const response = await bridgeWorker.fetch(request, createEnv());

    expect(response.status).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 401 on missing or invalid signature before parsing JSON", async () => {
    const malformedBody = "{not-valid-json";
    const missingSigRequest = createSignedRequest(malformedBody, { signature: null });
    const badSigRequest = createSignedRequest(malformedBody, {
      signature: `sha256=${"0".repeat(64)}`,
    });

    const missingResponse = await bridgeWorker.fetch(missingSigRequest, createEnv());
    const badResponse = await bridgeWorker.fetch(badSigRequest, createEnv());

    expect(missingResponse.status).toBe(401);
    expect(await missingResponse.text()).toBe("");
    expect(badResponse.status).toBe(401);
    expect(await badResponse.text()).toBe("");
  });

  it("returns 200 ignored for non-pull_request_review_thread events", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = JSON.stringify({ zen: "Keep it logically awesome." });

    const pingResponse = await bridgeWorker.fetch(
      createSignedRequest(body, { event: "ping" }),
      createEnv(),
    );
    const missingEventResponse = await bridgeWorker.fetch(
      createSignedRequest(body, { event: null }),
      createEnv(),
    );

    expect(pingResponse.status).toBe(200);
    expect(missingEventResponse.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 200 ignored for actions other than resolved or unresolved", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = JSON.stringify(createThreadPayload({ action: "edited" }));

    const response = await bridgeWorker.fetch(createSignedRequest(body), createEnv());

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["non-object JSON", "[]"],
    ["missing action", JSON.stringify(createThreadPayload({ action: undefined }))],
    ["missing repository", JSON.stringify(createThreadPayload({ repository: undefined }))],
    [
      "invalid repository.full_name",
      JSON.stringify(
        createThreadPayload({
          repository: { full_name: "not-a-repo", default_branch: "main" },
        }),
      ),
    ],
    [
      "missing repository.default_branch",
      JSON.stringify(
        createThreadPayload({
          repository: { full_name: "octocat/hello-world", default_branch: "" },
        }),
      ),
    ],
    ["missing pull_request", JSON.stringify(createThreadPayload({ pull_request: undefined }))],
    [
      "invalid pull_request.number",
      JSON.stringify(
        createThreadPayload({
          pull_request: { number: 0, head: { sha: "abc123" } },
        }),
      ),
    ],
    [
      "missing pull_request.head.sha",
      JSON.stringify(
        createThreadPayload({
          pull_request: { number: 42, head: { sha: "" } },
        }),
      ),
    ],
  ])("returns 400 on %s", async (_label, body) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await bridgeWorker.fetch(createSignedRequest(body), createEnv());

    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces ALLOWED_REPOSITORIES case-insensitively and allows when unset or empty", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const body = JSON.stringify(
      createThreadPayload({
        repository: { full_name: "Octocat/Hello-World", default_branch: "main" },
      }),
    );

    const forbidden = await bridgeWorker.fetch(
      createSignedRequest(body),
      createEnv({ ALLOWED_REPOSITORIES: "other/repo, another/project" }),
    );
    expect(forbidden.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    const { ctx: ctxAllowed, waitUntil: waitAllowed } = createExecutionContext();
    const allowedByCase = await bridgeWorker.fetch(
      createSignedRequest(body),
      createEnv({ ALLOWED_REPOSITORIES: "other/repo, octocat/hello-world" }),
      ctxAllowed,
    );
    expect(allowedByCase.status).toBe(202);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(waitAllowed.mock.calls.map(([promise]) => promise));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const { ctx: ctxEmpty, waitUntil: waitEmpty } = createExecutionContext();
    const allowedWhenEmpty = await bridgeWorker.fetch(
      createSignedRequest(body),
      createEnv({ ALLOWED_REPOSITORIES: " , " }),
      ctxEmpty,
    );
    expect(allowedWhenEmpty.status).toBe(202);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(waitEmpty.mock.calls.map(([promise]) => promise));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing GITHUB_WEBHOOK_SECRET", { GITHUB_WEBHOOK_SECRET: undefined }],
    ["empty GITHUB_WEBHOOK_SECRET", { GITHUB_WEBHOOK_SECRET: "   " }],
    ["missing GITHUB_DISPATCH_TOKEN", { GITHUB_DISPATCH_TOKEN: undefined }],
    ["empty GITHUB_DISPATCH_TOKEN", { GITHUB_DISPATCH_TOKEN: "" }],
    ["invalid DEBOUNCE_WINDOW_MS", { DEBOUNCE_WINDOW_MS: "0" }],
    ["oversized DEBOUNCE_WINDOW_MS", { DEBOUNCE_WINDOW_MS: "25001" }],
    ["non-integer DEBOUNCE_WINDOW_MS", { DEBOUNCE_WINDOW_MS: "12.5" }],
    ["invalid WORKFLOW_ID", { WORKFLOW_ID: "dir/workflow.yml" }],
  ])("returns 500 fail-closed when %s", async (_label, envOverrides) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const body = JSON.stringify(createThreadPayload());

    const response = await bridgeWorker.fetch(createSignedRequest(body), createEnv(envOverrides));

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 202, calls ctx.waitUntil, and dispatches workflow_dispatch after debounce window", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const body = JSON.stringify(
      createThreadPayload({
        action: "unresolved",
        repository: { full_name: "owner/repo", default_branch: "trunk" },
        pull_request: { number: 99, head: { sha: "deadbeef" } },
      }),
    );
    const { ctx, waitUntil } = createExecutionContext();

    const response = await bridgeWorker.fetch(
      createSignedRequest(body),
      createEnv({ WORKFLOW_ID: "custom.yml", DEBOUNCE_WINDOW_MS: "2500" }),
      ctx,
    );

    expect(response.status).toBe(202);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2499);
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const completion = waitUntil.mock.calls[0]?.[0];
    expect(completion).toBeInstanceOf(Promise);
    await completion;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/actions/workflows/custom.yml/dispatches",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${DISPATCH_TOKEN}`);
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
    expect(headers.get("User-Agent")).toBe("merge-verdict-bridge");
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "trunk",
      inputs: {
        pull_request_number: "99",
      },
    });
  });

  it("coalesces rapid duplicate valid requests into a single dispatch call", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);

    const firstBody = JSON.stringify(
      createThreadPayload({
        action: "resolved",
        pull_request: { number: 7, head: { sha: "sha-first" } },
      }),
    );
    const secondBody = JSON.stringify(
      createThreadPayload({
        action: "unresolved",
        pull_request: { number: 7, head: { sha: "sha-second" } },
      }),
    );
    const { ctx: ctx1, waitUntil: wait1 } = createExecutionContext();
    const { ctx: ctx2, waitUntil: wait2 } = createExecutionContext();
    const env = createEnv({ DEBOUNCE_WINDOW_MS: "5000" });

    const r1 = await bridgeWorker.fetch(createSignedRequest(firstBody), env, ctx1);
    await vi.advanceTimersByTimeAsync(1000);
    const r2 = await bridgeWorker.fetch(createSignedRequest(secondBody), env, ctx2);

    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(wait1.mock.calls[0]?.[0]).toBe(wait2.mock.calls[0]?.[0]);
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4000);
    await wait1.mock.calls[0]?.[0];

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("passes latest headSha and defaultBranch when createWebhookHandler coalesces requests", async () => {
    const dispatches: unknown[] = [];
    const handler = createWebhookHandler({
      webhookSecret: WEBHOOK_SECRET,
      windowMs: 50,
      dispatch: async (input) => {
        dispatches.push(input);
      },
    });

    const firstBody = JSON.stringify(
      createThreadPayload({
        repository: { full_name: "octocat/hello-world", default_branch: "main" },
        pull_request: { number: 12, head: { sha: "sha-1" } },
      }),
    );
    const secondBody = JSON.stringify(
      createThreadPayload({
        repository: { full_name: "octocat/hello-world", default_branch: "release" },
        pull_request: { number: 12, head: { sha: "sha-2" } },
      }),
    );

    const { ctx, waitUntil } = createExecutionContext();
    expect((await handler(createSignedRequest(firstBody), ctx)).status).toBe(202);
    expect((await handler(createSignedRequest(secondBody))).status).toBe(202);

    await vi.advanceTimersByTimeAsync(50);
    await waitUntil.mock.calls[0]?.[0];

    expect(dispatches).toEqual([
      {
        repository: "octocat/hello-world",
        prNumber: 12,
        headSha: "sha-2",
        defaultBranch: "release",
      },
    ]);
  });

  it("rejects non-POST on createWebhookHandler and cleans up after failed dispatch", async () => {
    let shouldFail = true;
    const handler = createWebhookHandler({
      webhookSecret: WEBHOOK_SECRET,
      windowMs: 10,
      dispatch: async () => {
        if (shouldFail) {
          throw new Error("boom");
        }
      },
    });

    expect((await handler(createSignedRequest("", { method: "GET" }))).status).toBe(405);

    const body = JSON.stringify(createThreadPayload());
    const { ctx: failCtx, waitUntil: failWait } = createExecutionContext();
    expect((await handler(createSignedRequest(body), failCtx)).status).toBe(202);
    const failedPromise = failWait.mock.calls[0]?.[0];
    const rejectionAssertion = expect(failedPromise).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(10);
    await rejectionAssertion;

    shouldFail = false;
    const { ctx: okCtx, waitUntil: okWait } = createExecutionContext();
    expect((await handler(createSignedRequest(body), okCtx)).status).toBe(202);
    await vi.advanceTimersByTimeAsync(10);
    await expect(okWait.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });
});
