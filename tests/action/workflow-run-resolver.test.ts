import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import {
  type ResolveWorkflowRunPullRequestNumberInput,
  resolveWorkflowRunPullRequestNumber,
  type WorkflowRunPayload,
  type WorkflowRunResolverArtifactItem,
  type WorkflowRunResolverPullRequestItem,
  type WorkflowRunResolverRestClient,
} from "../../src/action/workflow-run-resolver.js";

function makeMatchingPullRequest(number = 42): WorkflowRunResolverPullRequestItem {
  return { number, head: { sha: "a".repeat(40), repo: { full_name: "contributor/hello-world" } } };
}

function makeTargetArtifact(number = 42): WorkflowRunResolverArtifactItem {
  return { name: `deepseek-review-target-pr-${number}`, expired: false };
}

function createRestMock(overrides?: {
  pullsList?: WorkflowRunResolverRestClient["pulls"]["list"];
  listWorkflowRunArtifacts?: WorkflowRunResolverRestClient["actions"]["listWorkflowRunArtifacts"];
}) {
  const pullsList = vi.fn<WorkflowRunResolverRestClient["pulls"]["list"]>(
    overrides?.pullsList ?? (async () => ({ data: [] })),
  );
  const listWorkflowRunArtifacts = vi.fn<
    WorkflowRunResolverRestClient["actions"]["listWorkflowRunArtifacts"]
  >(overrides?.listWorkflowRunArtifacts ?? (async () => ({ data: { artifacts: [] } })));

  const rest: WorkflowRunResolverRestClient = {
    pulls: { list: pullsList },
    actions: { listWorkflowRunArtifacts },
  };

  return { rest, pullsList, listWorkflowRunArtifacts };
}

function makeForkPullRequestWorkflowRun(
  overrides: Partial<WorkflowRunPayload> = {},
): WorkflowRunPayload {
  return {
    id: 1001,
    event: "pull_request",
    path: ".github/workflows/ci.yml",
    head_sha: "A".repeat(40),
    head_branch: "feat/fork-change",
    head_repository: {
      full_name: "contributor/hello-world",
      owner: { login: "contributor" },
    },
    repository: { full_name: "octocat/hello-world" },
    pull_requests: [],
    ...overrides,
  };
}

function makeIssueCommentWorkflowRun(
  overrides: Partial<WorkflowRunPayload> = {},
): WorkflowRunPayload {
  return {
    id: 2002,
    event: "issue_comment",
    path: ".github/workflows/deepseek-review.yml",
    head_sha: "b".repeat(40),
    head_branch: "main",
    repository: { full_name: "octocat/hello-world" },
    pull_requests: [],
    ...overrides,
  };
}

describe("resolveWorkflowRunPullRequestNumber", () => {
  it("is type-compatible with Octokit['rest']", () => {
    const check = (octokit: Octokit, workflowRun: WorkflowRunPayload) => {
      const input: ResolveWorkflowRunPullRequestNumberInput = {
        owner: "octocat",
        repo: "hello-world",
        workflowRun,
        rest: octokit.rest,
      };
      return resolveWorkflowRunPullRequestNumber(input);
    };

    expect(typeof check).toBe("function");
  });

  describe("direct workflow_run.pull_requests resolution", () => {
    it("returns single-entry pull_requests[0].number directly without API calls", async () => {
      const { rest, pullsList, listWorkflowRunArtifacts } = createRestMock();

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: {
          id: 500,
          event: "pull_request",
          pull_requests: [{ number: 42 }],
        },
        rest,
      });

      expect(prNumber).toBe(42);
      expect(pullsList).not.toHaveBeenCalled();
      expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
    });

    it("returns null for multiple pull_requests entries without API calls", async () => {
      const { rest, pullsList, listWorkflowRunArtifacts } = createRestMock();

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: {
          id: 501,
          event: "pull_request",
          pull_requests: [{ number: 42 }, { number: 43 }],
        },
        rest,
      });

      expect(prNumber).toBeNull();
      expect(pullsList).not.toHaveBeenCalled();
      expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, null, undefined])(
      "returns null when single pull_requests[0].number is invalid (%s)",
      async (invalidNumber) => {
        const { rest, pullsList, listWorkflowRunArtifacts } = createRestMock();

        const prNumber = await resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun: {
            id: 502,
            event: "pull_request",
            pull_requests: [{ number: invalidNumber as number | null | undefined }],
          },
          rest,
        });

        expect(prNumber).toBeNull();
        expect(pullsList).not.toHaveBeenCalled();
        expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
      },
    );

    it("returns null when workflowRun is null or owner/repo is blank", async () => {
      const { rest, pullsList, listWorkflowRunArtifacts } = createRestMock();

      expect(
        await resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun: null,
          rest,
        }),
      ).toBeNull();
      expect(
        await resolveWorkflowRunPullRequestNumber({
          owner: " ",
          repo: "hello-world",
          workflowRun: makeForkPullRequestWorkflowRun(),
          rest,
        }),
      ).toBeNull();
      expect(pullsList).not.toHaveBeenCalled();
      expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
    });
  });

  describe("fork pull_request workflow_run resolution", () => {
    it.each([false, true])(
      "checks later pages before resolving a unique match (ambiguous: %s)",
      async (ambiguous) => {
        const match = makeMatchingPullRequest();
        const { rest, pullsList } = createRestMock({
          pullsList: async (params) =>
            params.page === 2
              ? { data: ambiguous ? [{ ...match, number: 43 }] : [match] }
              : {
                  data: ambiguous ? [match] : [],
                  headers: { link: '<https://api.github.com/next>; rel="next"' },
                },
        });

        const result = await resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun: makeForkPullRequestWorkflowRun(),
          rest,
        });

        expect(result).toBe(ambiguous ? null : 42);
        expect(pullsList).toHaveBeenCalledTimes(2);
        expect(pullsList).toHaveBeenLastCalledWith({
          owner: "octocat",
          repo: "hello-world",
          state: "open",
          head: "contributor:feat/fork-change",
          per_page: 100,
          page: 2,
        });
      },
    );

    it("returns null when pagination remains incomplete at the page cap", async () => {
      const { rest, pullsList } = createRestMock({
        pullsList: async () => ({
          data: [makeMatchingPullRequest()],
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        }),
      });

      const result = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeForkPullRequestWorkflowRun(),
        rest,
      });

      expect(result).toBeNull();
      expect(pullsList).toHaveBeenCalledTimes(10);
    });
    it("queries open PRs by forkOwner:headBranch and returns the single exact case-insensitive SHA and head repo match", async () => {
      const headSha = "aBcDeF0123456789aBcDeF0123456789aBcDeF01";
      const { rest, pullsList, listWorkflowRunArtifacts } = createRestMock({
        pullsList: async () => ({
          data: [
            {
              number: 11,
              head: {
                sha: "f".repeat(40),
                repo: { full_name: "contributor/hello-world" },
              },
            },
            {
              number: 12,
              head: {
                sha: headSha.toLowerCase(),
                repo: { full_name: "other-fork/hello-world" },
              },
            },
            {
              number: 13,
              head: {
                sha: headSha.toLowerCase(),
                repo: { full_name: "Contributor/Hello-World" },
              },
            },
          ],
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeForkPullRequestWorkflowRun({
          head_sha: headSha.toUpperCase(),
          head_branch: "feat/fork-change",
          head_repository: {
            full_name: "contributor/hello-world",
            owner: { login: "contributor" },
          },
        }),
        rest,
      });

      expect(prNumber).toBe(13);
      expect(pullsList).toHaveBeenCalledTimes(1);
      expect(pullsList).toHaveBeenCalledWith({
        owner: "octocat",
        repo: "hello-world",
        state: "open",
        head: "contributor:feat/fork-change",
        per_page: 100,
      });
      expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
    });

    it("derives forkOwner from head_repository.full_name when owner.login is omitted", async () => {
      const sha = "c".repeat(40);
      const { rest, pullsList } = createRestMock({
        pullsList: async () => ({
          data: [
            {
              number: 77,
              head: { sha, repo: { full_name: "alice/hello-world" } },
            },
          ],
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeForkPullRequestWorkflowRun({
          head_sha: sha,
          head_branch: "fix-bug",
          head_repository: { full_name: "alice/hello-world" },
        }),
        rest,
      });

      expect(prNumber).toBe(77);
      expect(pullsList).toHaveBeenCalledWith({
        owner: "octocat",
        repo: "hello-world",
        state: "open",
        head: "alice:fix-bug",
        per_page: 100,
      });
    });

    it("returns null when 0 open PRs match exact head.sha and head.repo.full_name", async () => {
      const { rest } = createRestMock({
        pullsList: async () => ({
          data: [
            {
              number: 15,
              head: { sha: "0".repeat(40), repo: { full_name: "contributor/hello-world" } },
            },
            {
              number: 16,
              head: { sha: "a".repeat(40), repo: null },
            },
          ],
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeForkPullRequestWorkflowRun(),
        rest,
      });

      expect(prNumber).toBeNull();
    });

    it("returns null when more than 1 open PR matches (ambiguous)", async () => {
      const sha = "d".repeat(40);
      const { rest } = createRestMock({
        pullsList: async () => ({
          data: [
            {
              number: 21,
              head: { sha, repo: { full_name: "contributor/hello-world" } },
            },
            {
              number: 22,
              head: { sha: sha.toUpperCase(), repo: { full_name: "Contributor/Hello-World" } },
            },
          ],
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeForkPullRequestWorkflowRun({ head_sha: sha }),
        rest,
      });

      expect(prNumber).toBeNull();
    });

    it.each([
      { label: "missing head_sha", patch: { head_sha: undefined } },
      { label: "blank head_sha", patch: { head_sha: "   " } },
      { label: "missing head_branch", patch: { head_branch: null } },
      { label: "blank head_branch", patch: { head_branch: "" } },
      { label: "missing head_repository", patch: { head_repository: null } },
      {
        label: "missing head_repository.full_name",
        patch: { head_repository: { owner: { login: "contributor" } } },
      },
      {
        label: "malformed head_repository.full_name",
        patch: { head_repository: { full_name: "invalid-without-slash" } },
      },
      {
        label: "dot-segment head_repository.full_name",
        patch: { head_repository: { full_name: "../hello-world" } },
      },
      {
        label: "conflicting head_repository.owner.login",
        patch: {
          head_repository: {
            full_name: "contributor/hello-world",
            owner: { login: "someone-else" },
          },
        },
      },
    ])("returns null without calling pulls.list when $label", async ({ patch }) => {
      const { rest, pullsList } = createRestMock();

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeForkPullRequestWorkflowRun(patch),
        rest,
      });

      expect(prNumber).toBeNull();
      expect(pullsList).not.toHaveBeenCalled();
    });
  });

  describe("issue_comment workflow_run resolution", () => {
    it.each([false, true])(
      "checks later artifact pages before resolving (ambiguous: %s)",
      async (ambiguous) => {
        const artifact = makeTargetArtifact();
        const { rest, listWorkflowRunArtifacts } = createRestMock({
          listWorkflowRunArtifacts: async (params) =>
            params.page === 2
              ? {
                  data: {
                    artifacts: [
                      ambiguous ? { ...artifact, name: "deepseek-review-target-pr-43" } : artifact,
                    ],
                  },
                }
              : {
                  data: { artifacts: ambiguous ? [artifact] : [] },
                  headers: { link: '<https://api.github.com/next>; rel="next"' },
                },
        });

        const result = await resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun: makeIssueCommentWorkflowRun(),
          rest,
        });

        expect(result).toBe(ambiguous ? null : 42);
        expect(listWorkflowRunArtifacts).toHaveBeenCalledTimes(2);
        expect(listWorkflowRunArtifacts).toHaveBeenLastCalledWith({
          owner: "octocat",
          repo: "hello-world",
          run_id: 2002,
          per_page: 100,
          page: 2,
        });
      },
    );

    it("returns null for incomplete artifact pagination at the page cap", async () => {
      const { rest, listWorkflowRunArtifacts } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: { artifacts: [makeTargetArtifact()] },
          headers: { link: '<https://api.github.com/next>; rel="next"' },
        }),
      });

      const result = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun(),
        rest,
      });

      expect(result).toBeNull();
      expect(listWorkflowRunArtifacts).toHaveBeenCalledTimes(10);
    });
    it("resolves pr-agent.yml run from unexpired pr-agent-review-provenance-pr-<N> artifact", async () => {
      const { rest, listWorkflowRunArtifacts, pullsList } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: {
            artifacts: [
              { name: "pr-agent-review-provenance-pr-19", expired: true },
              { name: "unrelated-artifact", expired: false },
              { name: "pr-agent-review-provenance-pr-88", expired: false },
            ],
          },
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun({
          id: 9001,
          path: ".github/workflows/pr-agent.yml",
          repository: { full_name: "Octocat/Hello-World" },
        }),
        rest,
      });

      expect(prNumber).toBe(88);
      expect(listWorkflowRunArtifacts).toHaveBeenCalledTimes(1);
      expect(listWorkflowRunArtifacts).toHaveBeenCalledWith({
        owner: "octocat",
        repo: "hello-world",
        run_id: 9001,
        per_page: 100,
      });
      expect(pullsList).not.toHaveBeenCalled();
    });

    it("resolves deepseek-review.yml run from unexpired deepseek-review-target-pr-<N> artifact", async () => {
      const { rest, listWorkflowRunArtifacts } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: {
            artifacts: [{ name: "deepseek-review-target-pr-104", expired: false }],
          },
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun({
          id: 9002,
          path: ".github/workflows/deepseek-review.yml",
        }),
        rest,
      });

      expect(prNumber).toBe(104);
      expect(listWorkflowRunArtifacts).toHaveBeenCalledWith({
        owner: "octocat",
        repo: "hello-world",
        run_id: 9002,
        per_page: 100,
      });
    });

    it("deduplicates matching unexpired artifacts resolving to the same PR number", async () => {
      const { rest } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: {
            artifacts: [
              { name: "deepseek-review-target-pr-55", expired: false },
              { name: "deepseek-review-target-pr-55", expired: false },
            ],
          },
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun(),
        rest,
      });

      expect(prNumber).toBe(55);
    });

    it("returns null for non-allowlisted workflow paths without calling API", async () => {
      const { rest, listWorkflowRunArtifacts } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: {
            artifacts: [{ name: "deepseek-review-target-pr-12", expired: false }],
          },
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun({
          path: ".github/workflows/ci.yml",
        }),
        rest,
      });

      expect(prNumber).toBeNull();
      expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
    });

    it("returns null for cross-repo runs without calling API", async () => {
      const { rest, listWorkflowRunArtifacts } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: {
            artifacts: [{ name: "deepseek-review-target-pr-12", expired: false }],
          },
        }),
      });

      expect(
        await resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun: makeIssueCommentWorkflowRun({
            repository: { full_name: "someone-else/hello-world" },
          }),
          rest,
        }),
      ).toBeNull();

      expect(
        await resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun: makeIssueCommentWorkflowRun({
            head_repository: { full_name: "contributor/hello-world" },
          }),
          rest,
        }),
      ).toBeNull();

      expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
    });

    it("returns null when unexpired matching artifact count is 0 or names are invalid/mismatched", async () => {
      for (const artifacts of [
        [],
        [{ name: "deepseek-review-target-pr-42", expired: true }],
        [{ name: "pr-agent-review-provenance-pr-42", expired: false }],
        [{ name: "deepseek-review-target-pr-0", expired: false }],
        [{ name: "deepseek-review-target-pr-042", expired: false }],
        [{ name: "deepseek-review-target-pr-abc", expired: false }],
        [{ name: "deepseek-review-target-pr-42-extra", expired: false }],
      ]) {
        const { rest } = createRestMock({
          listWorkflowRunArtifacts: async () => ({ data: { artifacts } }),
        });

        const prNumber = await resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun: makeIssueCommentWorkflowRun(),
          rest,
        });

        expect(prNumber).toBeNull();
      }
    });

    it("returns null when multiple distinct unexpired PR artifacts exist (ambiguous)", async () => {
      const { rest } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: {
            artifacts: [
              { name: "pr-agent-review-provenance-pr-10", expired: false },
              { name: "pr-agent-review-provenance-pr-11", expired: false },
            ],
          },
        }),
      });

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun({
          path: ".github/workflows/pr-agent.yml",
        }),
        rest,
      });

      expect(prNumber).toBeNull();
    });

    it.each([
      { label: "missing id", patch: { id: undefined } },
      { label: "non-positive id", patch: { id: 0 } },
      { label: "missing path", patch: { path: null } },
      { label: "missing repository", patch: { repository: null } },
      { label: "missing repository.full_name", patch: { repository: {} } },
    ])("returns null without calling API when $label", async ({ patch }) => {
      const { rest, listWorkflowRunArtifacts } = createRestMock();

      const prNumber = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun(patch),
        rest,
      });

      expect(prNumber).toBeNull();
      expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
    });
  });

  it.each(["pull_request", "issue_comment"])(
    "propagates later-page API failures for %s",
    async (event) => {
      const failure = new Error("API unavailable");
      const { rest, pullsList, listWorkflowRunArtifacts } = createRestMock({
        pullsList: async (params) => {
          if (params.page === 2) throw failure;
          return { data: [], headers: { link: '<https://api.github.com/next>; rel="next"' } };
        },
        listWorkflowRunArtifacts: async (params) => {
          if (params.page === 2) throw failure;
          return {
            data: { artifacts: [] },
            headers: { link: '<https://api.github.com/next>; rel="next"' },
          };
        },
      });
      const workflowRun =
        event === "pull_request" ? makeForkPullRequestWorkflowRun() : makeIssueCommentWorkflowRun();

      await expect(
        resolveWorkflowRunPullRequestNumber({
          owner: "octocat",
          repo: "hello-world",
          workflowRun,
          rest,
        }),
      ).rejects.toBe(failure);
      expect(event === "pull_request" ? pullsList : listWorkflowRunArtifacts).toHaveBeenCalledTimes(
        2,
      );
    },
  );

  it("refuses an incomplete 1000-item artifact listing without requesting more", async () => {
    const { rest, listWorkflowRunArtifacts } = createRestMock({
      listWorkflowRunArtifacts: async () => ({
        data: { artifacts: Array.from({ length: 1000 }, () => makeTargetArtifact()) },
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      }),
    });

    const result = await resolveWorkflowRunPullRequestNumber({
      owner: "octocat",
      repo: "hello-world",
      workflowRun: makeIssueCommentWorkflowRun(),
      rest,
    });

    expect(result).toBeNull();
    expect(listWorkflowRunArtifacts).toHaveBeenCalledTimes(1);
  });

  it.each([999, 1000, 1001])(
    "bounds artifact accumulation to 1000 items (%s returned)",
    async (size) => {
      const { rest } = createRestMock({
        listWorkflowRunArtifacts: async () => ({
          data: { artifacts: Array.from({ length: size }, () => makeTargetArtifact()) },
        }),
      });

      const result = await resolveWorkflowRunPullRequestNumber({
        owner: "octocat",
        repo: "hello-world",
        workflowRun: makeIssueCommentWorkflowRun(),
        rest,
      });

      expect(result).toBe(size > 1000 ? null : 42);
    },
  );

  it("returns null for other workflow_run events with empty pull_requests without API calls", async () => {
    const { rest, pullsList, listWorkflowRunArtifacts } = createRestMock();

    const prNumber = await resolveWorkflowRunPullRequestNumber({
      owner: "octocat",
      repo: "hello-world",
      workflowRun: {
        id: 3003,
        event: "push",
        path: ".github/workflows/ci.yml",
        repository: { full_name: "octocat/hello-world" },
        pull_requests: [],
      },
      rest,
    });

    expect(prNumber).toBeNull();
    expect(pullsList).not.toHaveBeenCalled();
    expect(listWorkflowRunArtifacts).not.toHaveBeenCalled();
  });
});
