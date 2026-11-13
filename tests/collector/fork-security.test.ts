import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { GitHubCollector } from "../../src/index.js";

const input = { owner: "maintainer", repo: "project", pullRequestNumber: 24 };
const baseRepository = "maintainer/project";
const trustedPolicy = "required_reviewers: [security-reviewer]\nrequired_checks: [security]";
const untrustedPolicy = "required_reviewers: []\nrequired_checks: []";

function createFixture(options: {
  readonly headRepository: string | null;
  readonly policyStatus?: number;
}) {
  const requests: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    requests.push(url);
    let data: unknown;
    let status = 200;
    if (url.pathname === "/graphql") {
      const body = init?.body ?? (request instanceof Request ? await request.clone().text() : "");
      const { query } = JSON.parse(String(body)) as { readonly query: string };
      const connection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      data = {
        data: {
          repository: {
            pullRequest: query.includes("ChangedFiles")
              ? { files: connection }
              : { reviewThreads: connection },
          },
        },
      };
    } else if (url.pathname.endsWith("/pulls/24")) {
      data = {
        head: {
          ref: "main",
          sha: "untrusted-head-sha",
          repo: options.headRepository === null ? null : { full_name: options.headRepository },
        },
        base: { ref: "main", sha: "protected-base-sha", repo: { full_name: baseRepository } },
      };
    } else if (decodeURIComponent(url.pathname).endsWith("/contents/.github/merge-verdict.yml")) {
      const untrusted = url.searchParams.get("ref") === "untrusted-head-sha";
      status = untrusted ? 200 : (options.policyStatus ?? 200);
      data =
        status === 200
          ? {
              type: "file",
              encoding: "base64",
              content: Buffer.from(untrusted ? untrustedPolicy : trustedPolicy).toString("base64"),
            }
          : { message: "Not Found" };
    } else {
      data = url.pathname.endsWith("/check-runs") ? { total_count: 0, check_runs: [] } : [];
    }
    const response = new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  });
  const rest = new Octokit({ auth: "test-token", request: { fetch: fetcher } });
  const graph = graphql.defaults({ request: { fetch: fetcher } });
  return {
    collector: new GitHubCollector(rest, graph, { sleep: async () => {} }),
    policyRequests: () =>
      requests.filter((url) => decodeURIComponent(url.pathname).includes("/contents/")),
  };
}

describe("fork policy isolation", () => {
  it.each([
    { headRepository: baseRepository, expectedFork: false },
    { headRepository: "contributor/project", expectedFork: true },
    { headRepository: null, expectedFork: true },
  ])(
    "reports fork metadata for head repository $headRepository",
    async ({ headRepository, expectedFork }) => {
      const fixture = createFixture({ headRepository });
      const result = await fixture.collector.collectPullRequest(input);

      expect(result.isFork).toBe(expectedFork);
      expect(result.policyVersion).toBe("protected-base-sha");
      expect(result.policyContent).toBe(trustedPolicy);
      expect(
        fixture
          .policyRequests()
          .map((url) => [decodeURIComponent(url.pathname), url.searchParams.get("ref")]),
      ).toEqual([
        ["/repos/maintainer/project/contents/.github/merge-verdict.yml", "protected-base-sha"],
      ]);
    },
  );

  it("keeps policy on the base revision when evaluating a different commit", async () => {
    const fixture = createFixture({ headRepository: "contributor/project" });
    const result = await fixture.collector.collectPullRequest({
      ...input,
      evaluationSha: "another-evaluation-sha",
    });

    expect(result.evaluationSha).toBe("another-evaluation-sha");
    expect(result.policyVersion).toBe("protected-base-sha");
    expect(result.policyContent).toBe(trustedPolicy);
    expect(fixture.policyRequests().map((url) => url.searchParams.get("ref"))).toEqual([
      "protected-base-sha",
    ]);
  });

  it("uses the caller-supplied protected policy revision rather than the fork head", async () => {
    const fixture = createFixture({ headRepository: "contributor/project" });
    const result = await fixture.collector.collectPullRequest({
      ...input,
      policySha: "protected-policy-sha",
    });

    expect(result.policyVersion).toBe("protected-policy-sha");
    expect(result.policyContent).toBe(trustedPolicy);
    expect(fixture.policyRequests().map((url) => url.searchParams.get("ref"))).toEqual([
      "protected-policy-sha",
    ]);
  });

  it("fails closed when base policy is missing even if a permissive fork policy exists", async () => {
    const fixture = createFixture({ headRepository: "contributor/project", policyStatus: 404 });

    await expect(fixture.collector.collectPullRequest(input)).rejects.toMatchObject({
      name: "GitHubCollectorError",
      kind: "policy",
      status: 404,
    });
    expect(fixture.policyRequests().map((url) => url.searchParams.get("ref"))).toEqual([
      "protected-base-sha",
    ]);
  });
});
