import { createHash } from "node:crypto";
import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { createGitHubCollector, GitHubCollector, GitHubCollectorError } from "../../src/index.js";

const repository = { owner: "octocat", repo: "hello-world" };
const pullRequestNumber = 123;
const EXPECTED_THREAD_COMMENT_CONCURRENCY = 5;
const PAGINATED_THREAD_COUNT = 8;

function jsonResponse(
  data: unknown,
  options: { readonly status?: number; readonly headers?: Record<string, string> } = {},
  url?: string,
): Response {
  const response = new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (url !== undefined) {
    Object.defineProperty(response, "url", { value: url });
  }
  return response;
}

function createPullRequestPayload(): object {
  return {
    number: pullRequestNumber,
    draft: false,
    mergeable: true,
    head: { ref: "feature", sha: "head-sha" },
    base: { ref: "main", sha: "base-sha" },
    user: { login: "octocat" },
  };
}

function createPolicyContentPayload(): object {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from("verification: true").toString("base64"),
  };
}

function createIssueComment(id: number, body: string): object {
  return {
    id,
    body,
    user: { login: "review-bot" },
    updated_at: "2026-10-01T12:00:00Z",
  };
}

function createReview(id: number, state: string): object {
  return {
    id,
    user: { login: "reviewer" },
    state,
    commit_id: "head-sha",
    submitted_at: "2026-10-01T12:00:00Z",
    body: "review body",
  };
}

function createCheckRun(
  id: number,
  name: string,
  output: object = { title: "tests", summary: "passed", text: "All checks passed." },
): object {
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
    head_sha: "head-sha",
    html_url: `https://github.com/octocat/hello-world/actions/runs/${id}`,
    output,
    started_at: "2026-10-01T12:00:00Z",
    completed_at: "2026-10-01T12:01:00Z",
  };
}

function createCommitStatus(
  context: string,
  state = "success",
  timestamp = "2026-10-01T12:00:00Z",
): object {
  return {
    context,
    state,
    target_url: "https://example.test/check",
    description: "passed",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function createReviewComment(id: string, body: string): object {
  return {
    id,
    body,
    author: { login: "review-bot" },
    path: "src/a.ts",
    line: 7,
    originalLine: 5,
    updatedAt: "2026-10-01T12:00:00Z",
    commit: { oid: "head-sha" },
  };
}

function createThread(
  id: string,
  comments: readonly object[],
  pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null,
  },
): object {
  return {
    id,
    isResolved: true,
    isOutdated: false,
    resolvedBy: { login: "reviewer" },
    path: "src/a.ts",
    line: 7,
    originalLine: 5,
    comments: { nodes: comments, pageInfo },
  };
}

function createCollector(fetcher: typeof fetch): GitHubCollector {
  const rest = new Octokit({ auth: "test-token", request: { fetch: fetcher } });
  const graph = graphql.defaults({
    headers: { authorization: "token test-token" },
    request: { fetch: fetcher },
  });
  return new GitHubCollector(rest, graph);
}

function nextPageHeaders(url: URL, page: number): Record<string, string> {
  if (page !== 1) {
    return {};
  }

  const nextUrl = new URL(url);
  nextUrl.searchParams.set("page", "2");
  return { link: `<${nextUrl.href}>; rel="next"` };
}

function createStandardFetch(
  policyStatus = 200,
  checkRunStatus = 200,
  policyPayload: unknown = createPolicyContentPayload(),
): {
  readonly fetcher: typeof fetch;
  readonly requests: URL[];
} {
  const requests: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    const pathname = decodeURIComponent(requestUrl.pathname);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push(requestUrl);

    if (pathname === "/graphql") {
      const requestBody =
        init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      const { query, variables } = JSON.parse(String(requestBody)) as {
        readonly query: string;
        readonly variables: Record<string, unknown>;
      };
      if (query.includes("ChangedFiles")) {
        const filePage =
          variables.cursor === null
            ? {
                nodes: [{ path: "src/a.ts" }],
                pageInfo: { hasNextPage: true, endCursor: "files-cursor-1" },
              }
            : { nodes: [{ path: "src/b.ts" }], pageInfo: { hasNextPage: false, endCursor: null } };
        return jsonResponse(
          { data: { repository: { pullRequest: { files: filePage } } } },
          {},
          requestUrl.href,
        );
      }
      const thread = createThread("thread-1", [createReviewComment("comment-1", "finding")]);
      return jsonResponse(
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [thread],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
        { headers: { "x-test-query": query.includes("reviewThreads") ? "threads" : "other" } },
        requestUrl.href,
      );
    }

    if (pathname.endsWith("/pulls/123") && method === "GET") {
      return jsonResponse(createPullRequestPayload(), {}, requestUrl.href);
    }

    const page = Number(requestUrl.searchParams.get("page") ?? "1");
    if (pathname.endsWith("/issues/123/comments")) {
      const comments =
        page === 1 ? [createIssueComment(1, "summary body")] : [createIssueComment(2, "second")];
      return jsonResponse(
        comments,
        { headers: nextPageHeaders(requestUrl, page) },
        requestUrl.href,
      );
    }

    if (pathname.endsWith("/pulls/123/reviews")) {
      const reviews =
        page === 1 ? [createReview(1, "APPROVED")] : [createReview(2, "CHANGES_REQUESTED")];
      return jsonResponse(reviews, { headers: nextPageHeaders(requestUrl, page) }, requestUrl.href);
    }

    if (pathname.endsWith("/check-runs")) {
      if (checkRunStatus !== 200) {
        return jsonResponse(
          { message: "Resource not accessible by integration" },
          { status: checkRunStatus, headers: { "x-ratelimit-remaining": "0" } },
          requestUrl.href,
        );
      }
      const runs =
        page === 1
          ? [createCheckRun(1, "tests")]
          : [createCheckRun(2, "lint", { title: null, summary: null, text: null })];
      return jsonResponse(
        { total_count: 2, check_runs: runs },
        { headers: nextPageHeaders(requestUrl, page) },
        requestUrl.href,
      );
    }

    if (pathname.endsWith("/statuses")) {
      const statuses =
        page === 1
          ? [createCommitStatus("tests", "pending", "2026-10-01T11:00:00Z")]
          : [
              createCommitStatus("tests", "success", "2026-10-01T12:00:00Z"),
              createCommitStatus("lint", "success", "2026-10-01T11:30:00Z"),
            ];
      return jsonResponse(
        statuses,
        { headers: nextPageHeaders(requestUrl, page) },
        requestUrl.href,
      );
    }

    if (pathname.endsWith("/contents/.github/merge-verdict.yml")) {
      return policyStatus === 200
        ? jsonResponse(policyPayload, {}, requestUrl.href)
        : jsonResponse({ message: "Not Found" }, { status: policyStatus }, requestUrl.href);
    }

    return jsonResponse({}, {}, requestUrl.href);
  });

  return { fetcher, requests };
}

describe("GitHubCollector", () => {
  it("collects PR state across REST pages and binds mutable state to the base and head SHAs", async () => {
    const { fetcher, requests } = createStandardFetch();
    const collector = createCollector(fetcher);

    const result = await collector.collectPullRequest({ ...repository, pullRequestNumber });

    expect(result).toMatchObject({
      repository: "octocat/hello-world",
      pullRequestNumber,
      headSha: "head-sha",
      baseSha: "base-sha",
      headRef: "feature",
      baseRef: "main",
      isDraft: false,
      authorLogin: "octocat",
      evaluationSha: "head-sha",
      policyVersion: "base-sha",
      changedFilePaths: ["src/a.ts", "src/b.ts"],
      policyContent: "verification: true",
    });
    expect(result.reviewThreads).toEqual([
      expect.objectContaining({
        id: "thread-1",
        isResolved: true,
        resolvedByLogin: "reviewer",
        isOutdated: false,
        path: "src/a.ts",
        line: 7,
        originalLine: 5,
        comments: [
          expect.objectContaining({
            id: "comment-1",
            body: "finding",
            authorLogin: "review-bot",
            bodyDigest: createHash("sha256").update("finding").digest("hex"),
          }),
        ],
      }),
    ]);
    expect(result.conversationComments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(result.conversationComments[0]?.bodyDigest).toBe(
      createHash("sha256").update("summary body").digest("hex"),
    );
    expect(result.reviews.map((review) => review.state)).toEqual(["APPROVED", "CHANGES_REQUESTED"]);
    expect(result.checkRuns.map((run) => run.name)).toEqual(["tests", "lint"]);
    expect(result.checkRuns[0]?.output).toEqual({
      title: "tests",
      summary: "passed",
      text: "All checks passed.",
    });
    expect(result.checkRuns[1]?.output).toEqual({ title: null, summary: null, text: null });
    expect(result.commitStatuses.map((status) => status.context)).toEqual(["tests", "lint"]);
    expect(result.commitStatuses.map((status) => status.state)).toEqual(["success", "success"]);

    for (const suffix of [
      "/issues/123/comments",
      "/pulls/123/reviews",
      "/check-runs",
      "/statuses",
    ]) {
      expect(
        requests.some(
          (url) => url.pathname.endsWith(suffix) && url.searchParams.get("page") === "2",
        ),
      ).toBe(true);
    }
    expect(
      requests
        .find((url) =>
          decodeURIComponent(url.pathname).endsWith("/contents/.github/merge-verdict.yml"),
        )
        ?.searchParams.get("ref"),
    ).toBe("base-sha");
    expect(
      requests
        .filter((url) => url.pathname.endsWith("/check-runs"))
        .every((url) => url.pathname.includes("/head-sha/")),
    ).toBe(true);
    expect(
      requests
        .filter((url) => url.pathname.endsWith("/statuses"))
        .every((url) => url.pathname.includes("/head-sha/")),
    ).toBe(true);
  });

  it("paginates GraphQL review threads and comments in pages of 100", async () => {
    const requests: Array<{ readonly query: string; readonly variables: Record<string, unknown> }> =
      [];
    let activeCommentRequests = 0;
    let maxCommentRequests = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(url.pathname);
      if (pathname !== "/graphql") {
        if (pathname.endsWith("/pulls/123")) {
          return jsonResponse(createPullRequestPayload(), {}, url.href);
        }
        if (pathname.endsWith("/contents/.github/merge-verdict.yml")) {
          return jsonResponse(createPolicyContentPayload(), {}, url.href);
        }
        return jsonResponse([], {}, url.href);
      }

      const requestBody =
        init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      const request = JSON.parse(String(requestBody)) as {
        readonly query: string;
        readonly variables: Record<string, unknown>;
      };
      requests.push(request);

      if (request.query.includes("ChangedFiles")) {
        const filePage =
          request.variables.cursor === null
            ? {
                nodes: Array.from({ length: 100 }, (_, index) => ({
                  path: `src/file-${index + 1}.ts`,
                })),
                pageInfo: { hasNextPage: true, endCursor: "files-cursor-100" },
              }
            : {
                nodes: [{ path: "src/file-101.ts" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              };
        return jsonResponse(
          { data: { repository: { pullRequest: { files: filePage } } } },
          {},
          url.href,
        );
      }

      if (request.query.includes("node(id:")) {
        const threadId = String(request.variables.threadId);
        activeCommentRequests += 1;
        maxCommentRequests = Math.max(maxCommentRequests, activeCommentRequests);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeCommentRequests -= 1;
        return jsonResponse(
          {
            data: {
              node: {
                comments: {
                  nodes: [createReviewComment(`${threadId}-extra`, "last comment")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
          {},
          url.href,
        );
      }

      const cursor = request.variables.cursor;
      const nodes =
        cursor === null
          ? Array.from({ length: 100 }, (_, index) =>
              createThread(
                `thread-${index + 1}`,
                index === 0 ? [createReviewComment("comment-1", "first comment")] : [],
                index < PAGINATED_THREAD_COUNT
                  ? { hasNextPage: true, endCursor: `comment-cursor-${index + 1}` }
                  : { hasNextPage: false, endCursor: null },
              ),
            )
          : [createThread("thread-101", [])];

      return jsonResponse(
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes,
                  pageInfo: {
                    hasNextPage: cursor === null,
                    endCursor: cursor === null ? "thread-cursor-100" : null,
                  },
                },
              },
            },
          },
        },
        {},
        url.href,
      );
    });
    const collector = createCollector(fetcher);

    const result = await collector.collectPullRequest({ ...repository, pullRequestNumber });

    expect(result.reviewThreads).toHaveLength(101);
    expect(result.changedFilePaths).toEqual(
      Array.from({ length: 101 }, (_, index) => `src/file-${index + 1}.ts`),
    );
    expect(result.reviewThreads.map((thread) => thread.id)).toEqual(
      Array.from({ length: 101 }, (_, index) => `thread-${index + 1}`),
    );
    expect(result.reviewThreads[0]?.comments.map((comment) => comment.id)).toEqual([
      "comment-1",
      "thread-1-extra",
    ]);
    expect(result.reviewThreads[1]?.comments.map((comment) => comment.id)).toEqual([
      "thread-2-extra",
    ]);
    const threadQueries = requests.filter(({ query }) => query.includes("reviewThreads"));
    const commentQueries = requests.filter(({ query }) => query.includes("node(id:"));
    const fileQueries = requests.filter(({ query }) => query.includes("ChangedFiles"));
    expect(threadQueries).toHaveLength(2);
    expect(commentQueries).toHaveLength(PAGINATED_THREAD_COUNT);
    expect(fileQueries).toHaveLength(2);
    expect(requests.every(({ query }) => query.includes("first: 100"))).toBe(true);
    expect(threadQueries.map(({ variables }) => variables.cursor)).toContain(null);
    expect(threadQueries.map(({ variables }) => variables.cursor)).toContain("thread-cursor-100");
    expect(new Set(commentQueries.map(({ variables }) => variables.cursor))).toEqual(
      new Set(
        Array.from({ length: PAGINATED_THREAD_COUNT }, (_, index) => `comment-cursor-${index + 1}`),
      ),
    );
    expect(fileQueries.map(({ variables }) => variables.cursor)).toContain("files-cursor-100");
    expect(maxCommentRequests).toBe(EXPECTED_THREAD_COMMENT_CONCURRENCY);
  });

  it("uses supplied evaluation and policy SHAs", async () => {
    const { fetcher, requests } = createStandardFetch();
    const collector = createCollector(fetcher);

    const result = await collector.collectPullRequest({
      ...repository,
      pullRequestNumber,
      evaluationSha: "merge-group-sha",
      policySha: "merge-group-base-sha",
    });
    expect(result.policyVersion).toBe("merge-group-base-sha");
    expect(result.commitStatuses.map((status) => status.commitSha)).toEqual([
      "merge-group-sha",
      "merge-group-sha",
    ]);

    expect(
      requests
        .filter((url) => url.pathname.endsWith("/check-runs"))
        .every((url) => url.pathname.includes("/merge-group-sha/")),
    ).toBe(true);
    expect(
      requests
        .filter((url) => url.pathname.endsWith("/statuses"))
        .every((url) => url.pathname.includes("/merge-group-sha/")),
    ).toBe(true);
    expect(
      requests
        .find((url) =>
          decodeURIComponent(url.pathname).endsWith("/contents/.github/merge-verdict.yml"),
        )
        ?.searchParams.get("ref"),
    ).toBe("merge-group-base-sha");
  });

  it("fails closed when the base policy file cannot be read", async () => {
    const { fetcher } = createStandardFetch(404);
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({
      kind: "policy",
      status: 404,
      message: expect.stringContaining(".github/merge-verdict.yml at base-sha"),
    });
  });

  it.each([
    {
      label: "a directory",
      payload: [{ name: "nested", path: ".github/merge-verdict.yml/nested", type: "file" }],
      message: "directory",
    },
    {
      label: "a non-file entry",
      payload: { type: "symlink", encoding: "none", content: "" },
      message: 'type "symlink"',
    },
    {
      label: "an oversized file response",
      payload: { type: "file", encoding: "none", size: 1_000_001, content: "" },
      message: 'encoding "none"',
    },
  ])("rejects a policy response that is $label", async ({ payload, message }) => {
    const { fetcher } = createStandardFetch(200, 200, payload);
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "policy", message: expect.stringContaining(message) });
  });

  it("rejects an empty GitHub token", () => {
    const createWithEmptyToken = () => createGitHubCollector(" \t\n");

    expect(createWithEmptyToken).toThrowError(TypeError);
    expect(createWithEmptyToken).toThrowError(
      "A non-empty GitHub token is required to create a GitHubCollector.",
    );
  });

  it("does not classify an unrelated permission failure as a rate limit", async () => {
    const { fetcher } = createStandardFetch(200, 403);
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "api", status: 403 });
  });

  it("returns a typed rate-limit error", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/pulls/123")) {
        return jsonResponse(createPullRequestPayload(), {}, url.href);
      }
      if (pathname.endsWith("/check-runs")) {
        return jsonResponse(
          { message: "API rate limit exceeded" },
          { status: 403, headers: { "x-ratelimit-remaining": "0" } },
          url.href,
        );
      }
      if (pathname === "/graphql") {
        const requestBody =
          init?.body ?? (input instanceof Request ? await input.clone().text() : "");
        const { query } = JSON.parse(String(requestBody)) as { readonly query: string };
        if (query.includes("ChangedFiles")) {
          return jsonResponse(
            {
              data: {
                repository: {
                  pullRequest: {
                    files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
              },
            },
            {},
            url.href,
          );
        }
        return jsonResponse(
          {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          },
          {},
          url.href,
        );
      }
      if (pathname.endsWith("/contents/.github/merge-verdict.yml")) {
        return jsonResponse(createPolicyContentPayload(), {}, url.href);
      }
      return jsonResponse([], {}, url.href);
    });
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "rate_limit", status: 403 });
  });

  it("recognizes GraphQL secondary rate-limit errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/pulls/123")) {
        return jsonResponse(createPullRequestPayload(), {}, url.href);
      }
      if (pathname === "/graphql") {
        return jsonResponse(
          { data: {}, errors: [{ type: "RATE_LIMITED", message: "Request denied" }] },
          { headers: { "x-ratelimit-remaining": "10" } },
          url.href,
        );
      }
      if (pathname.endsWith("/contents/.github/merge-verdict.yml")) {
        return jsonResponse(createPolicyContentPayload(), {}, url.href);
      }
      return jsonResponse([], {}, url.href);
    });
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "rate_limit" });
  });

  it("rejects a GraphQL pagination response without a new cursor", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/pulls/123")) {
        return jsonResponse(createPullRequestPayload(), {}, url.href);
      }
      if (pathname === "/graphql") {
        const requestBody =
          init?.body ?? (input instanceof Request ? await input.clone().text() : "");
        const { query } = JSON.parse(String(requestBody)) as { readonly query: string };
        const pullRequestData = query.includes("ChangedFiles")
          ? { files: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } }
          : {
              reviewThreads: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            };
        return jsonResponse(
          { data: { repository: { pullRequest: pullRequestData } } },
          {},
          url.href,
        );
      }
      if (pathname.endsWith("/contents/.github/merge-verdict.yml")) {
        return jsonResponse(createPolicyContentPayload(), {}, url.href);
      }
      return jsonResponse([], {}, url.href);
    });
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "api" });
  });

  it("returns a typed network error", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "network" });
  });

  it("redacts authorization headers in wrapped error causes", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/pulls/123")) {
        const nested = Object.assign(new Error("Transport failed"), {
          headers: {
            authorization: "token sensitive-token-12345",
            cookie: "session=sensitive-cookie-12345",
            "x-github-token": "sensitive-token-12345",
          },
          cause: undefined as unknown,
        });
        nested.cause = nested;
        throw nested;
      }
      return jsonResponse({}, {}, url.href);
    });
    const rest = new Octokit({
      auth: "sensitive-token-12345",
      request: { fetch: fetcher },
    });
    const graph = graphql.defaults({
      headers: { authorization: "token sensitive-token-12345" },
      request: { fetch: fetcher },
    });
    const collector = new GitHubCollector(rest, graph);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    const collectorError = error as GitHubCollectorError;
    const cause = collectorError.cause as {
      readonly message?: string;
      readonly stack?: string;
      readonly request?: { readonly headers?: Record<string, string> };
      readonly cause?: {
        readonly headers?: Record<string, string>;
        readonly cause?: unknown;
      };
    };
    expect(cause?.request?.headers?.authorization).toBe("[REDACTED]");
    expect(cause?.cause?.headers).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "x-github-token": "[REDACTED]",
    });
    expect(cause?.cause?.cause).toBeUndefined();
    expect(cause?.message).toContain("Transport failed");
    expect(typeof cause?.stack).toBe("string");
    expect(JSON.stringify(collectorError.cause)).not.toContain("sensitive-token-12345");
    expect(JSON.stringify(collectorError.cause)).not.toContain("sensitive-cookie-12345");
  });

  it("extracts HTTP status code from GraphqlResponseError response", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/pulls/123")) {
        return jsonResponse(createPullRequestPayload(), {}, url.href);
      }
      if (pathname === "/graphql") {
        return jsonResponse(
          { data: null, errors: [{ message: "Field is forbidden" }] },
          { status: 403 },
          url.href,
        );
      }
      return jsonResponse({}, {}, url.href);
    });
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "api", status: 403 });
  });

  it("classifies forbidden base policy file error as policy kind", async () => {
    const { fetcher } = createStandardFetch(403);
    const collector = createCollector(fetcher);

    const error = await collector
      .collectPullRequest({ ...repository, pullRequestNumber })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({
      kind: "policy",
      status: 403,
      message: expect.stringContaining(".github/merge-verdict.yml at base-sha"),
    });
  });
});
