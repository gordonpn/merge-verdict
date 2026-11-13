import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { createRetryRequest } from "../../src/collector/client.js";
import { type CollectorRetryEvent, GitHubCollector } from "../../src/index.js";

function apiError(status: number, headers: Record<string, string> = {}, message = "failure") {
  return Object.assign(new Error(message), { status, response: { status, headers } });
}

function setup() {
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const debug = vi.fn<(event: CollectorRetryEvent) => void>();
  const retry = createRetryRequest({ sleep, debug, random: () => 1, now: () => 0 });
  return { sleep, debug, retry };
}

describe("GitHub request retries", () => {
  it.each([500, 502, 503, 504])(
    "retries %i at most three times with exponential backoff",
    async (status) => {
      const { retry, sleep, debug } = setup();
      const error = apiError(status);
      const request = vi.fn().mockRejectedValue(error);
      await expect(retry("test", request)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls).toEqual([[1000], [2000], [4000]]);
      expect(debug.mock.calls.map(([event]) => event.attempt)).toEqual([1, 2, 3]);
    },
  );

  it("returns successful recovery and varies jitter within bounded delays", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const retry = createRetryRequest({ sleep, random: () => 0 });
    const request = vi.fn().mockRejectedValueOnce(apiError(502)).mockResolvedValue("ok");
    await expect(retry("test", request)).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it.each([403, 429])("honors Retry-After for HTTP %i", async (status) => {
    const { retry, sleep } = setup();
    const request = vi
      .fn()
      .mockRejectedValueOnce(apiError(status, { "Retry-After": "5" }))
      .mockResolvedValue("ok");
    await retry("test", request);
    expect(sleep.mock.calls).toEqual([[5000]]);
  });

  it("honors HTTP dates and primary limit reset times", async () => {
    const { retry, sleep } = setup();
    await retry(
      "test",
      vi
        .fn()
        .mockRejectedValueOnce(apiError(429, { "retry-after": "Thu, 01 Jan 1970 00:00:05 GMT" }))
        .mockResolvedValue("ok"),
    );
    await retry(
      "test",
      vi
        .fn()
        .mockRejectedValueOnce(
          apiError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "8" }),
        )
        .mockResolvedValue("ok"),
    );
    expect(sleep.mock.calls).toEqual([[5000], [8000]]);
  });

  it("does not retry early when Retry-After exceeds remaining budget", async () => {
    const { retry, sleep } = setup();
    const error = apiError(429, { "retry-after": "31" });
    const request = vi.fn().mockRejectedValue(error);
    await expect(retry("test", request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("shares a 30 second cumulative delay cap across concurrent operations", async () => {
    const { retry, sleep } = setup();
    const request = vi.fn().mockRejectedValue(apiError(429, { "retry-after": "10" }));
    await Promise.allSettled([retry("first", request), retry("second", request)]);
    expect(sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe(30_000);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404, 422])("does not retry nonretryable HTTP %i", async (status) => {
    const { retry, sleep } = setup();
    const error = apiError(status);
    const request = vi.fn().mockRejectedValue(error);
    await expect(retry("test", request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry arbitrary network or programming errors", async () => {
    const { retry, sleep } = setup();
    await expect(
      retry("test", async () => {
        throw new TypeError("bad input");
      }),
    ).rejects.toThrow("bad input");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recognizes GraphQL RATE_LIMITED responses with HTTP 200", async () => {
    const { retry, sleep } = setup();
    const error = Object.assign(new Error("denied"), {
      response: { status: 200 },
      errors: [{ type: "RATE_LIMITED" }],
    });
    await retry("graphql", vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok"));
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("logs safe structured metadata and ignores failing debug sinks", async () => {
    const { retry, debug } = setup();
    const error = Object.assign(apiError(503, { authorization: "secret-token" }, "secret-body"), {
      request: { url: "https://secret-host", headers: { authorization: "secret-token" } },
    });
    await retry("rest", vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok"));
    expect(debug.mock.calls[0]).toEqual([
      {
        event: "github_api_retry",
        operation: "rest",
        attempt: 1,
        status: 503,
        delayMs: 1000,
        cumulativeDelayMs: 1000,
      },
    ]);
    expect(JSON.stringify(debug.mock.calls)).not.toContain("secret");
    await expect(
      createRetryRequest({
        sleep: async () => {},
        debug: () => {
          throw new Error("logger");
        },
      })("rest", vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok")),
    ).resolves.toBe("ok");
  });
});

function response(data: unknown, url: URL, status = 200, headers: Record<string, string> = {}) {
  const result = new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
  Object.defineProperty(result, "url", { value: url.href });
  return result;
}

it("retries failing REST and GraphQL pages in place without repeating earlier pages", async () => {
  const calls = new Map<string, number>();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    let key = `${url.pathname}:${url.searchParams.get("page") ?? "1"}`;
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      const files = body.query.includes("ChangedFiles");
      const cursor = body.variables.cursor;
      key = `${files ? "files" : "threads"}:${cursor ?? "1"}`;
      const count = (calls.get(key) ?? 0) + 1;
      calls.set(key, count);
      if (files && cursor === "second" && count === 1)
        return response({ message: "unavailable" }, url, 503);
      return response(
        {
          data: {
            repository: {
              pullRequest: {
                [files ? "files" : "reviewThreads"]: {
                  nodes: files ? [{ path: cursor ? "b.ts" : "a.ts" }] : [],
                  pageInfo: {
                    hasNextPage: files && !cursor,
                    endCursor: files && !cursor ? "second" : null,
                  },
                },
              },
            },
          },
        },
        url,
      );
    }
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if (url.pathname.endsWith("/pulls/1"))
      return response(
        {
          head: { sha: "head", ref: "feature", repo: { full_name: "octocat/hello-world" } },
          base: { sha: "base", ref: "main", repo: { full_name: "octocat/hello-world" } },
        },
        url,
      );
    if (url.pathname.includes("/contents/"))
      return response({ type: "file", encoding: "base64", content: "" }, url);
    if (url.pathname.endsWith("/comments")) {
      if (!url.searchParams.has("page")) {
        const next = new URL(url);
        next.searchParams.set("page", "2");
        return response([{ id: 1, body: "first" }], url, 200, { link: `<${next}>; rel="next"` });
      }
      if (count === 1) return response({ message: "unavailable" }, url, 502);
      return response([{ id: 2, body: "second" }], url);
    }
    return response(
      url.pathname.endsWith("/check-runs") ? { check_runs: [], total_count: 0 } : [],
      url,
    );
  };
  const rest = new Octokit({ request: { fetch: fetcher } });
  const graph = graphql.defaults({ request: { fetch: fetcher } });
  const collector = new GitHubCollector(rest, graph, { sleep, random: () => 1 });
  const result = await collector.collectPullRequest({
    owner: "test",
    repo: "repo",
    pullRequestNumber: 1,
  });
  expect(result.changedFilePaths).toEqual(["a.ts", "b.ts"]);
  expect(result.conversationComments.map(({ id }) => id)).toEqual([1, 2]);
  expect(calls.get("/repos/test/repo/issues/1/comments:1")).toBe(1);
  expect(calls.get("/repos/test/repo/issues/1/comments:2")).toBe(2);
  expect(calls.get("files:1")).toBe(1);
  expect(calls.get("files:second")).toBe(2);
  expect(sleep).toHaveBeenCalledTimes(2);
});
