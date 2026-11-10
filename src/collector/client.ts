import { AsyncLocalStorage } from "node:async_hooks";
import type { Octokit } from "@octokit/rest";

/** Safe retry metadata. Request URLs, headers, bodies and error messages are never logged. */
export interface CollectorRetryEvent {
  readonly event: "github_api_retry";
  readonly operation: string;
  readonly attempt: number;
  readonly status: number | null;
  readonly delayMs: number;
  readonly cumulativeDelayMs: number;
}

/** Optional dependencies for deterministic testing and structured debug logging. */
export interface CollectorRetryOptions {
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly debug?: (event: CollectorRetryEvent) => void;
}

export type RetryRequest = <T>(operation: string, request: () => Promise<T>) => Promise<T>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function header(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(record(headers) ?? {})) {
    if (key.toLowerCase() === name && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  return undefined;
}

/** Returns retry metadata without copying untrusted error details into logs. */
function retryMetadata(error: unknown, now: number) {
  const value = record(error);
  const response = record(value?.response);
  const rawStatus = value?.status ?? response?.status;
  const status = typeof rawStatus === "number" ? rawStatus : null;
  const headers = response?.headers ?? value?.headers;
  const retryAfter = header(headers, "retry-after");
  const remaining = header(headers, "x-ratelimit-remaining");
  const errors = value?.errors;
  const graphqlRateLimit =
    Array.isArray(errors) && errors.some((item: unknown) => record(item)?.type === "RATE_LIMITED");
  const rateLimited =
    status === 429 ||
    graphqlRateLimit ||
    (status === 403 &&
      (retryAfter !== undefined ||
        remaining === "0" ||
        (typeof value?.message === "string" && /rate limit|abuse detection/i.test(value.message))));
  const retryable = rateLimited || (status !== null && status >= 500 && status <= 599);
  let minimumDelayMs = 0;
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    minimumDelayMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Number.isFinite(date)
        ? Math.max(0, date - now)
        : 0;
  }
  if (rateLimited && remaining === "0") {
    const reset = Number(header(headers, "x-ratelimit-reset"));
    if (Number.isFinite(reset)) minimumDelayMs = Math.max(minimumDelayMs, reset * 1000 - now);
  }
  return { status, retryable, minimumDelayMs };
}

/**
 * Creates a collection-scoped retry runner. Each operation gets at most three
 * retries; all concurrent operations share a cumulative 30 second delay budget.
 * Delays are reserved before awaiting, preventing concurrent budget overruns.
 * Retry-After delays beyond the remaining budget abort without retrying early.
 */
export function createRetryRequest(options: CollectorRetryOptions = {}): RetryRequest {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  let cumulativeDelayMs = 0;
  return async <T>(operation: string, request: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request();
      } catch (error) {
        const metadata = retryMetadata(error, now());
        if (!metadata.retryable || attempt >= 3) throw error;
        const sample = random();
        const jitter = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 1;
        const exponentialDelayMs = 1000 * 2 ** attempt * (0.5 + jitter * 0.5);
        const delayMs = Math.ceil(Math.max(exponentialDelayMs, metadata.minimumDelayMs));
        if (cumulativeDelayMs + delayMs > 30_000) throw error;
        cumulativeDelayMs += delayMs;
        try {
          options.debug?.({
            event: "github_api_retry",
            operation,
            attempt: attempt + 1,
            status: metadata.status,
            delayMs,
            cumulativeDelayMs,
          });
        } catch {
          // Observability must not alter collection or retry behavior.
        }
        await sleep(delayMs);
      }
    }
  };
}

const retryContext = new AsyncLocalStorage<RetryRequest>();
const configuredClients = new WeakSet<Octokit>();

/** Registers one request hook so each REST page retries in place. */
export function withRestRetries<T>(
  rest: Octokit,
  retry: RetryRequest,
  collect: () => Promise<T>,
): Promise<T> {
  if (!configuredClients.has(rest)) {
    rest.hook.wrap("request", (request, options) => {
      const currentRetry = retryContext.getStore();
      return currentRetry === undefined
        ? request(options)
        : currentRetry("rest", async () => request(options));
    });
    configuredClients.add(rest);
  }
  return retryContext.run(retry, collect);
}
