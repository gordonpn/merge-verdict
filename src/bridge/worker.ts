import { createDebouncer, type DispatchInput } from "./debouncer.js";
import { guardWebhookSignature } from "./verify-signature.js";

const DEFAULT_WORKFLOW_ID = "merge-verdict.yml";
const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "merge-verdict-bridge";
const DEFAULT_DEBOUNCE_WINDOW_MS = 5000;
const DISPATCH_TIMEOUT_MS = 4000;
// Keep background dispatch within Cloudflare Workers' 30s ctx.waitUntil lifetime.
const MAX_DEBOUNCE_WINDOW_MS = 25000;
const GITHUB_API_VERSION = "2022-11-28";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUPPORTED_ACTIONS = new Set(["resolved", "unresolved"]);

/**
 * Cloudflare Worker execution context subset needed to extend isolate lifetime.
 */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Environment bindings read by `bridgeWorker.fetch`.
 */
export interface BridgeEnv {
  readonly GITHUB_WEBHOOK_SECRET?: string | undefined;
  readonly GITHUB_DISPATCH_TOKEN?: string | undefined;
  readonly ALLOWED_REPOSITORIES?: string | undefined;
  readonly WORKFLOW_ID?: string | undefined;
  readonly DEBOUNCE_WINDOW_MS?: string | undefined;
}

/**
 * Validated payload forwarded to a GitHub `workflow_dispatch` dispatcher.
 */
export interface WorkflowDispatchInput extends DispatchInput {
  readonly defaultBranch: string;
}

/**
 * Function that dispatches a GitHub Actions workflow run for a pull request.
 */
export type WorkflowDispatcher = (input: WorkflowDispatchInput) => Promise<void>;

/**
 * Configuration for `createWorkflowDispatcher`.
 */
export interface WorkflowDispatcherOptions {
  readonly token: string;
  readonly workflowId?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * Configuration for `createWebhookHandler`.
 */
export interface WebhookHandlerOptions {
  readonly webhookSecret: string | undefined;
  readonly dispatch: (input: WorkflowDispatchInput) => void | Promise<void>;
  readonly allowedRepositories?: readonly string[] | undefined;
  readonly windowMs?: number | undefined;
}

/**
 * HTTP request handler for GitHub `pull_request_review_thread` webhooks.
 */
export type WebhookHandler = (request: Request, ctx?: WorkerExecutionContext) => Promise<Response>;

interface ParsedThreadPayload {
  readonly action: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly prNumber: number;
  readonly headSha: string;
}

interface ParsedBridgeConfig {
  readonly webhookSecret: string;
  readonly dispatchToken: string;
  readonly allowedRepositories: readonly string[];
  readonly allowedRepositoriesKey: string;
  readonly workflowId: string;
  readonly windowMs: number;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isValidRepository(value: unknown): value is string {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    return false;
  }
  const [owner, repo] = value.split("/");
  return owner !== "." && owner !== ".." && repo !== "." && repo !== "..";
}

function isValidNonEmptyRefOrSha(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function isValidWorkflowId(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !/\s/.test(value);
}

function parseThreadPayload(
  rawBody: unknown,
):
  | { readonly ok: true; readonly ignored: true }
  | { readonly ok: true; readonly ignored: false; readonly data: ParsedThreadPayload }
  | { readonly ok: false; readonly error: string } {
  const root = asRecord(rawBody);
  if (!root) {
    return { ok: false, error: "Webhook payload must be a JSON object" };
  }

  const action = root.action;
  if (typeof action !== "string") {
    return { ok: false, error: "Missing webhook action" };
  }
  if (!SUPPORTED_ACTIONS.has(action)) {
    return { ok: true, ignored: true };
  }

  const repositoryObj = asRecord(root.repository);
  const fullName = repositoryObj?.full_name;
  if (!isValidRepository(fullName)) {
    return { ok: false, error: "Missing or invalid repository.full_name" };
  }

  const defaultBranch = repositoryObj?.default_branch;
  if (!isValidNonEmptyRefOrSha(defaultBranch)) {
    return { ok: false, error: "Missing or invalid repository.default_branch" };
  }

  const pullRequestObj = asRecord(root.pull_request);
  const prNumber = pullRequestObj?.number;
  if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    return { ok: false, error: "Missing or invalid pull_request.number" };
  }

  const headObj = asRecord(pullRequestObj?.head);
  const headSha = headObj?.sha;
  if (!isValidNonEmptyRefOrSha(headSha)) {
    return { ok: false, error: "Missing or invalid pull_request.head.sha" };
  }

  return {
    ok: true,
    ignored: false,
    data: {
      action,
      repository: fullName,
      defaultBranch,
      prNumber,
      headSha,
    },
  };
}

/**
 * Create a GitHub Actions `workflow_dispatch` client for Merge Verdict.
 *
 * Accepts a bearer token, optional workflow filename or numeric ID (default
 * `merge-verdict.yml`), API base URL, user agent, and fetch implementation.
 * Throws on invalid configuration or inputs, network failure, a four-second
 * request timeout, and non-2xx API responses.
 */
export function createWorkflowDispatcher(options: WorkflowDispatcherOptions): WorkflowDispatcher {
  if (typeof options.token !== "string" || options.token.trim().length === 0) {
    throw new Error("GITHUB_DISPATCH_TOKEN must be a non-empty string");
  }
  const workflowId = (options.workflowId ?? DEFAULT_WORKFLOW_ID).trim();
  if (!isValidWorkflowId(workflowId)) {
    throw new Error("WORKFLOW_ID must be a non-empty workflow filename or ID without slashes");
  }
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  return async (input) => {
    if (!isValidRepository(input.repository)) {
      throw new TypeError("repository must be in owner/repo format");
    }
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
      throw new TypeError("prNumber must be a positive safe integer");
    }
    if (!isValidNonEmptyRefOrSha(input.defaultBranch)) {
      throw new TypeError("defaultBranch must be a non-empty ref without whitespace");
    }

    const [owner = "", repo = ""] = input.repository.split("/");
    const url =
      `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
      `/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;

    const fetchFn = options.fetch ?? globalThis.fetch;
    const response = await fetchFn(url, {
      method: "POST",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": userAgent,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: input.defaultBranch,
        inputs: {
          pull_request_number: String(input.prNumber),
        },
      }),
    });

    if (!response.ok) {
      const responseText = (await response.text().catch(() => "")).trim().slice(0, 500);
      const detail = responseText ? `: ${responseText}` : "";
      throw new Error(`GitHub workflow_dispatch failed with HTTP ${response.status}${detail}`);
    }
  };
}

/**
 * Create an HTTP handler that verifies GitHub webhook signatures, filters
 * `pull_request_review_thread` resolved/unresolved events, enforces an optional
 * repository allowlist, and debounces dispatches per repository and PR.
 */
export function createWebhookHandler(options: WebhookHandlerOptions): WebhookHandler {
  if (
    options.windowMs !== undefined &&
    (!Number.isInteger(options.windowMs) ||
      options.windowMs < 1 ||
      options.windowMs > MAX_DEBOUNCE_WINDOW_MS)
  ) {
    throw new RangeError(
      `windowMs must be an integer between 1 and ${MAX_DEBOUNCE_WINDOW_MS} to fit ctx.waitUntil limits`,
    );
  }

  const allowedList = (options.allowedRepositories ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const allowedSet = allowedList.length > 0 ? new Set(allowedList) : null;

  // Debouncer forwards only { repository, prNumber, headSha }, so retain each
  // window's latest defaultBranch keyed by the same repository:prNumber pair.
  const branchQueues = new Map<string, string[]>();
  const lastCompletion = new Map<string, Promise<void>>();

  const debouncer = createDebouncer({
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
    dispatch: async (input) => {
      const key = `${input.repository.toLowerCase()}:${input.prNumber}`;
      const queue = branchQueues.get(key);
      const defaultBranch = queue?.shift() ?? "";
      if (queue && queue.length === 0) {
        branchQueues.delete(key);
      }
      await options.dispatch({ ...input, defaultBranch });
    },
  });

  return async (request, ctx) => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const authFailure = await guardWebhookSignature(request, options.webhookSecret);
    if (authFailure) {
      return authFailure;
    }

    const eventName = request.headers.get("X-GitHub-Event")?.trim();
    if (eventName !== "pull_request_review_thread") {
      return jsonResponse(200, { status: "ignored", reason: "unsupported_event" });
    }

    let parsedJson: unknown;
    try {
      const text = await request.text();
      parsedJson = JSON.parse(text);
    } catch {
      return jsonResponse(400, { error: "Invalid JSON payload" });
    }

    const parsed = parseThreadPayload(parsedJson);
    if (!parsed.ok) {
      return jsonResponse(400, { error: parsed.error });
    }
    if (parsed.ignored) {
      return jsonResponse(200, { status: "ignored", reason: "unsupported_action" });
    }

    const { repository, defaultBranch, prNumber, headSha } = parsed.data;
    if (allowedSet !== null && !allowedSet.has(repository.toLowerCase())) {
      return jsonResponse(403, { error: "Repository is not allowed" });
    }

    const key = `${repository.toLowerCase()}:${prNumber}`;
    const queue = branchQueues.get(key) ?? [];
    const previousCompletion = lastCompletion.get(key);
    const completion = debouncer.enqueue({ repository, prNumber, headSha });

    if (completion === previousCompletion && queue.length > 0) {
      queue[queue.length - 1] = defaultBranch;
    } else {
      queue.push(defaultBranch);
      branchQueues.set(key, queue);
      lastCompletion.set(key, completion);
      void completion
        .finally(() => {
          if (lastCompletion.get(key) === completion) {
            lastCompletion.delete(key);
          }
        })
        .catch(() => {});
    }

    if (ctx?.waitUntil) {
      ctx.waitUntil(completion);
    }
    // Prevent unhandled rejection termination when callers omit ExecutionContext.
    void completion.catch(() => {});

    return jsonResponse(202, {
      status: "accepted",
      repository,
      pull_request_number: prNumber,
      head_sha: headSha,
    });
  };
}

function parseBridgeEnv(env: BridgeEnv): ParsedBridgeConfig | null {
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  const dispatchToken = env.GITHUB_DISPATCH_TOKEN;
  if (
    typeof webhookSecret !== "string" ||
    webhookSecret.trim().length === 0 ||
    typeof dispatchToken !== "string" ||
    dispatchToken.trim().length === 0
  ) {
    return null;
  }

  const rawWorkflowId = env.WORKFLOW_ID?.trim();
  const workflowId =
    rawWorkflowId && rawWorkflowId.length > 0 ? rawWorkflowId : DEFAULT_WORKFLOW_ID;
  if (!isValidWorkflowId(workflowId)) {
    return null;
  }

  const rawWindow = env.DEBOUNCE_WINDOW_MS?.trim();
  let windowMs = DEFAULT_DEBOUNCE_WINDOW_MS;
  if (rawWindow !== undefined && rawWindow.length > 0) {
    if (!/^[1-9]\d*$/.test(rawWindow)) {
      return null;
    }
    windowMs = Number.parseInt(rawWindow, 10);
    if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs > MAX_DEBOUNCE_WINDOW_MS) {
      return null;
    }
  }

  const allowedRepositories = (env.ALLOWED_REPOSITORIES ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return {
    webhookSecret,
    dispatchToken,
    allowedRepositories,
    allowedRepositoriesKey: allowedRepositories.join(","),
    workflowId,
    windowMs,
  };
}

let cachedHandlerState: {
  readonly config: ParsedBridgeConfig;
  readonly handler: WebhookHandler;
} | null = null;

function getOrCreateHandler(config: ParsedBridgeConfig): WebhookHandler {
  if (
    cachedHandlerState !== null &&
    cachedHandlerState.config.webhookSecret === config.webhookSecret &&
    cachedHandlerState.config.dispatchToken === config.dispatchToken &&
    cachedHandlerState.config.allowedRepositoriesKey === config.allowedRepositoriesKey &&
    cachedHandlerState.config.workflowId === config.workflowId &&
    cachedHandlerState.config.windowMs === config.windowMs
  ) {
    return cachedHandlerState.handler;
  }

  const dispatcher = createWorkflowDispatcher({
    token: config.dispatchToken,
    workflowId: config.workflowId,
  });
  const handler = createWebhookHandler({
    webhookSecret: config.webhookSecret,
    dispatch: dispatcher,
    allowedRepositories: config.allowedRepositories,
    windowMs: config.windowMs,
  });
  cachedHandlerState = { config, handler };
  return handler;
}

/**
 * Cloudflare Worker entrypoint relaying signed `pull_request_review_thread`
 * webhooks to GitHub Actions `workflow_dispatch`.
 */
export const bridgeWorker = {
  async fetch(request: Request, env: BridgeEnv, ctx?: WorkerExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const config = parseBridgeEnv(env);
    if (!config) {
      return jsonResponse(500, { error: "Bridge configuration is invalid or incomplete" });
    }

    const handler = getOrCreateHandler(config);
    return handler(request, ctx);
  },
};

export default bridgeWorker;
