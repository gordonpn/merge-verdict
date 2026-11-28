import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { GitHubCollector } from "../../src/index.js";

const repository = { owner: "octocat", repo: "hello-world" };
const pullRequestNumber = 26;

function jsonResponse(data: unknown, url?: string): Response {
  const response = new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  if (url !== undefined) {
    Object.defineProperty(response, "url", { value: url });
  }
  return response;
}

function createCollector(fetcher: typeof fetch): GitHubCollector {
  const rest = new Octokit({ auth: "test-token", request: { fetch: fetcher } });
  const graph = graphql.defaults({
    headers: { authorization: "token test-token" },
    request: { fetch: fetcher },
  });
  return new GitHubCollector(rest, graph, {
    sleep: async () => {},
    collectPrAgentProvenance: false,
  });
}

function createBaseRestHandler(pathname: string, url: string): Response | null {
  if (pathname.endsWith(`/pulls/${pullRequestNumber}`)) {
    return jsonResponse(
      {
        number: pullRequestNumber,
        draft: false,
        mergeable: true,
        head: { ref: "feature", sha: "head-sha", repo: { full_name: "octocat/hello-world" } },
        base: { ref: "main", sha: "base-sha", repo: { full_name: "octocat/hello-world" } },
        user: { login: "octocat" },
      },
      url,
    );
  }
  if (pathname.endsWith("/contents/.github/merge-verdict.yml")) {
    return jsonResponse(
      {
        type: "file",
        encoding: "base64",
        content: Buffer.from("verification: true").toString("base64"),
      },
      url,
    );
  }
  if (
    pathname.endsWith("/comments") ||
    pathname.endsWith("/reviews") ||
    pathname.endsWith("/statuses")
  ) {
    return jsonResponse([], url);
  }
  if (pathname.endsWith("/check-runs")) {
    return jsonResponse({ total_count: 0, check_runs: [] }, url);
  }
  if (pathname.endsWith("/commits")) {
    return jsonResponse([{ sha: "head-sha" }], url);
  }
  return null;
}

describe("GitHubCollector finding locations and changedFiles", () => {
  it("requests startLine, originalStartLine, and changeType and preserves multiline bounds across paginated GraphQL responses", async () => {
    const graphqlQueries: string[] = [];

    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(requestUrl.pathname);

      if (pathname === "/graphql") {
        const requestBody =
          init?.body ?? (input instanceof Request ? await input.clone().text() : "");
        const { query, variables } = JSON.parse(String(requestBody)) as {
          readonly query: string;
          readonly variables: Record<string, unknown>;
        };
        graphqlQueries.push(query);

        if (query.includes("query ChangedFiles")) {
          const filesPage =
            variables.cursor === null
              ? {
                  nodes: [
                    { path: "src/added.ts", changeType: "ADDED" },
                    { path: "src/renamed.ts", changeType: "RENAMED" },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "files-cursor-1" },
                }
              : {
                  nodes: [{ path: "src/deleted.ts", changeType: "DELETED" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                };
          return jsonResponse({
            data: { repository: { pullRequest: { files: filesPage } } },
          });
        }

        if (query.includes("query ReviewThreads")) {
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-multiline",
                        isResolved: false,
                        isOutdated: false,
                        resolvedBy: null,
                        path: "src/added.ts",
                        startLine: 10,
                        line: 18,
                        originalStartLine: 4,
                        originalLine: 12,
                        comments: {
                          nodes: [
                            {
                              id: "comment-1",
                              body: "First multiline comment",
                              author: { login: "coderabbitai[bot]" },
                              path: "src/added.ts",
                              startLine: 10,
                              line: 18,
                              originalStartLine: 4,
                              originalLine: 12,
                              createdAt: "2026-10-01T12:00:00Z",
                              updatedAt: "2026-10-01T12:00:00Z",
                              commit: { oid: "head-sha" },
                              originalCommit: { oid: "orig-sha" },
                            },
                          ],
                          pageInfo: { hasNextPage: true, endCursor: "comments-cursor-1" },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }

        if (query.includes("query ReviewThreadComments")) {
          return jsonResponse({
            data: {
              node: {
                comments: {
                  nodes: [
                    {
                      id: "comment-2",
                      body: "Follow-up comment",
                      author: { login: "octocat" },
                      path: "src/added.ts",
                      startLine: null,
                      line: 18,
                      originalStartLine: 4,
                      originalLine: 12,
                      createdAt: "2026-10-01T12:05:00Z",
                      updatedAt: "2026-10-01T12:05:00Z",
                      commit: { oid: "head-sha" },
                      originalCommit: { oid: "orig-sha" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }
      }

      const restResponse = createBaseRestHandler(pathname, requestUrl.href);
      if (restResponse) {
        return restResponse;
      }
      return jsonResponse({}, requestUrl.href);
    });

    const collector = createCollector(fetcher);
    const result = await collector.collectPullRequest({ ...repository, pullRequestNumber });

    const changedFilesQuery = graphqlQueries.find((q) => q.includes("query ChangedFiles"));
    expect(changedFilesQuery).toContain("changeType");

    const threadsQuery = graphqlQueries.find((q) => q.includes("query ReviewThreads"));
    expect(threadsQuery).toContain("startLine");
    expect(threadsQuery).toContain("originalStartLine");

    const threadCommentsQuery = graphqlQueries.find((q) =>
      q.includes("query ReviewThreadComments"),
    );
    expect(threadCommentsQuery).toContain("startLine");
    expect(threadCommentsQuery).toContain("originalStartLine");

    expect(result.changedFilePaths).toEqual(["src/added.ts", "src/renamed.ts", "src/deleted.ts"]);
    expect(result.changedFiles).toEqual([
      { path: "src/added.ts", changeType: "ADDED" },
      { path: "src/renamed.ts", changeType: "RENAMED" },
      { path: "src/deleted.ts", changeType: "DELETED" },
    ]);

    expect(result.reviewThreads[0]).toMatchObject({
      id: "thread-multiline",
      startLine: 10,
      line: 18,
      originalStartLine: 4,
      originalLine: 12,
    });
    expect(result.reviewThreads[0]?.comments[0]).toMatchObject({
      id: "comment-1",
      startLine: 10,
      line: 18,
      originalStartLine: 4,
      originalLine: 12,
    });
    expect(result.reviewThreads[0]?.comments[1]).toMatchObject({
      id: "comment-2",
      startLine: null,
      line: 18,
      originalStartLine: 4,
      originalLine: 12,
    });
  });

  it("defaults startLine, originalStartLine, and changeType to null when absent in legacy GraphQL mocks", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      const pathname = decodeURIComponent(requestUrl.pathname);

      if (pathname === "/graphql") {
        const requestBody =
          init?.body ?? (input instanceof Request ? await input.clone().text() : "");
        const { query } = JSON.parse(String(requestBody)) as { readonly query: string };

        if (query.includes("query ChangedFiles")) {
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  files: {
                    nodes: [{ path: "src/legacy.ts" }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }

        if (query.includes("query ReviewThreads")) {
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-legacy",
                        isResolved: false,
                        isOutdated: false,
                        resolvedBy: null,
                        path: "src/legacy.ts",
                        line: 7,
                        originalLine: 5,
                        comments: {
                          nodes: [
                            {
                              id: "comment-legacy",
                              body: "Legacy mock comment",
                              author: { login: "coderabbitai[bot]" },
                              path: "src/legacy.ts",
                              line: 7,
                              originalLine: 5,
                              createdAt: "2026-10-01T12:00:00Z",
                              updatedAt: "2026-10-01T12:00:00Z",
                              commit: { oid: "head-sha" },
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
      }

      const restResponse = createBaseRestHandler(pathname, requestUrl.href);
      if (restResponse) {
        return restResponse;
      }
      return jsonResponse({}, requestUrl.href);
    });

    const collector = createCollector(fetcher);
    const result = await collector.collectPullRequest({ ...repository, pullRequestNumber });

    expect(result.changedFilePaths).toEqual(["src/legacy.ts"]);
    expect(result.changedFiles).toEqual([{ path: "src/legacy.ts", changeType: null }]);
    expect(result.reviewThreads[0]?.startLine).toBeNull();
    expect(result.reviewThreads[0]?.originalStartLine).toBeNull();
    expect(result.reviewThreads[0]?.comments[0]?.startLine).toBeNull();
    expect(result.reviewThreads[0]?.comments[0]?.originalStartLine).toBeNull();
  });
});
