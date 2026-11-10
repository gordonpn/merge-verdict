import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { GitHubCollector, GitHubCollectorError } from "../../src/index.js";

const operations = [
  "changed_files",
  "review_threads",
  "thread_comments",
  "conversation_comments",
  "reviews",
  "check_runs",
  "commit_statuses",
] as const;
type Operation = (typeof operations)[number];

function comment(id: number) {
  return {
    id: `comment-${id}`,
    body: "finding",
    author: { login: "reviewer" },
    path: "src/a.ts",
    line: 1,
    originalLine: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    commit: { oid: "head" },
  };
}

function thread(id: number, comments = { nodes: [] as object[], pageInfo: pageInfo(1, 1) }) {
  return {
    id: `thread-${id}`,
    isResolved: false,
    isOutdated: false,
    resolvedBy: null,
    path: "src/a.ts",
    line: 1,
    originalLine: 1,
    comments,
  };
}

function pageInfo(page: number, totalPages: number) {
  return { hasNextPage: page < totalPages, endCursor: page < totalPages ? String(page) : null };
}

function fixture(target: Operation, itemsPerPage: number, totalPages: number) {
  let targetPages = 0;
  const response = (data: unknown, url: string, headers: Record<string, string> = {}) => {
    const result = new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", ...headers },
    });
    Object.defineProperty(result, "url", { value: url });
    return result;
  };
  const nodes = (page: number, mapper: (id: number) => object) =>
    Array.from({ length: itemsPerPage }, (_, index) => mapper((page - 1) * itemsPerPage + index));
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/graphql") {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { cursor: string | null };
      };
      const page = Number(variables.cursor ?? "0") + 1;
      const operation = query.includes("ChangedFiles")
        ? "changed_files"
        : query.includes("node(id:")
          ? "thread_comments"
          : "review_threads";
      if (operation === target) targetPages += 1;
      const info = operation === target ? pageInfo(page, totalPages) : pageInfo(1, 1);
      if (operation === "changed_files") {
        return response(
          {
            data: {
              repository: {
                pullRequest: {
                  files: {
                    nodes:
                      target === operation ? nodes(page, (id) => ({ path: `src/${id}.ts` })) : [],
                    pageInfo: info,
                  },
                },
              },
            },
          },
          url.href,
        );
      }
      if (operation === "thread_comments") {
        return response(
          { data: { node: { comments: { nodes: nodes(page, comment), pageInfo: info } } } },
          url.href,
        );
      }
      let threads: object[] = target === operation ? nodes(page, (id) => thread(id)) : [];
      if (target === "thread_comments") {
        targetPages += 1;
        threads = [thread(1, { nodes: nodes(1, comment), pageInfo: pageInfo(1, totalPages) })];
      }
      return response(
        {
          data: {
            repository: { pullRequest: { reviewThreads: { nodes: threads, pageInfo: info } } },
          },
        },
        url.href,
      );
    }
    if (url.pathname.endsWith("/pulls/123")) {
      return response(
        { head: { sha: "head", ref: "feature" }, base: { sha: "base", ref: "main" } },
        url.href,
      );
    }
    if (decodeURIComponent(url.pathname).includes("/contents/")) {
      return response(
        {
          type: "file",
          encoding: "base64",
          content: Buffer.from("verification: true").toString("base64"),
        },
        url.href,
      );
    }
    const operation = url.pathname.endsWith("/comments")
      ? "conversation_comments"
      : url.pathname.endsWith("/reviews")
        ? "reviews"
        : url.pathname.endsWith("/check-runs")
          ? "check_runs"
          : "commit_statuses";
    const page = Number(url.searchParams.get("page") ?? "1");
    if (operation === target) targetPages += 1;
    const records =
      operation !== target
        ? []
        : nodes(page, (id) => ({
            id,
            body: "finding",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            user: { login: "reviewer" },
            state: "APPROVED",
            commit_id: "head",
            name: `check-${id}`,
            status: "completed",
            conclusion: "success",
            head_sha: "head",
            output: {},
            context: `context-${id}`,
          }));
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    const headers =
      operation === target && page < totalPages ? { link: `<${next.href}>; rel="next"` } : {};
    return response(
      operation === "check_runs" ? { total_count: records.length, check_runs: records } : records,
      url.href,
      headers,
    );
  });
  const collector = new GitHubCollector(
    new Octokit({ request: { fetch: fetcher } }),
    graphql.defaults({ request: { fetch: fetcher } }),
  );
  return {
    collect: () =>
      collector.collectPullRequest({ owner: "owner", repo: "repo", pullRequestNumber: 123 }),
    pages: () => targetPages,
  };
}

function resultCount(
  result: Awaited<ReturnType<GitHubCollector["collectPullRequest"]>>,
  operation: Operation,
) {
  switch (operation) {
    case "changed_files":
      return result.changedFilePaths.length;
    case "review_threads":
      return result.reviewThreads.length;
    case "thread_comments":
      return result.reviewThreads[0]?.comments.length;
    case "conversation_comments":
      return result.conversationComments.length;
    case "reviews":
      return result.reviews.length;
    case "check_runs":
      return result.checkRuns.length;
    case "commit_statuses":
      return result.commitStatuses.length;
  }
}

describe.each(operations)("pagination bounds: %s", (operation) => {
  it("accepts exactly 1000 items across 10 complete pages", async () => {
    const subject = fixture(operation, 100, 10);
    expect(resultCount(await subject.collect(), operation)).toBe(1000);
    expect(subject.pages()).toBe(10);
  });

  it("rejects an unfinished connection at page 10 without requesting page 11", async () => {
    const subject = fixture(operation, 1, 11);
    await expect(subject.collect()).rejects.toMatchObject({
      name: "GitHubCollectorError",
      kind: "api",
      message: expect.stringContaining(`Pagination limit exceeded for ${operation}`),
    });
    expect(subject.pages()).toBe(10);
  });

  it("rejects an oversized response rather than truncating it", async () => {
    const subject = fixture(operation, 1001, 1);
    const error = await subject.collect().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubCollectorError);
    expect(error).toMatchObject({ kind: "api", message: expect.stringContaining("1001 items") });
    expect(subject.pages()).toBe(1);
  });

  it("rejects 1000 items with continuation before requesting another page", async () => {
    const subject = fixture(operation, 100, 11);
    await expect(subject.collect()).rejects.toMatchObject({ kind: "api" });
    expect(subject.pages()).toBe(10);
  });
});
