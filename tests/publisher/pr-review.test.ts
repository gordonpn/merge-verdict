import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalInput,
  type ApprovalReview,
  createOctokitApprovalClient,
  DEFAULT_APPROVAL_AUTHOR,
  DEFAULT_DISMISS_MESSAGE,
  DEFAULT_MAX_REVIEW_PAGES,
  publishPullRequestApproval,
} from "../../src/publisher/index.js";

const HEAD_SHA = "abc123def456";
const CHECK_RUN_URL = "https://github.com/owner/repo/runs/101";

interface RawGitHubReview {
  id: number;
  user: { login: string } | null;
  state: string;
  commit_id: string | null;
  submitted_at?: string | null;
  body?: string;
}

function makeRawReview(overrides: Partial<RawGitHubReview> = {}): RawGitHubReview {
  return {
    id: 10,
    user: { login: DEFAULT_APPROVAL_AUTHOR },
    state: "APPROVED",
    commit_id: HEAD_SHA,
    submitted_at: "2026-11-26T12:00:00Z",
    body: "Merge Verdict approved commit abc123def456",
    ...overrides,
  };
}

function makeApprovalReview(overrides: Partial<ApprovalReview> = {}): ApprovalReview {
  return {
    id: 10,
    author: DEFAULT_APPROVAL_AUTHOR,
    commitId: HEAD_SHA,
    state: "APPROVED",
    submittedAt: "2026-11-26T12:00:00Z",
    ...overrides,
  };
}

function makeApprovalInput(overrides: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    owner: "owner",
    repo: "repo",
    pullNumber: 42,
    headSha: HEAD_SHA,
    verdict: "PASS",
    pathEligible: true,
    checkRunUrl: CHECK_RUN_URL,
    ...overrides,
  };
}

function makeMockOctokit(
  overrides: {
    headSha?: string;
    reviews?: RawGitHubReview[];
    createReviewResponse?: RawGitHubReview;
  } = {},
) {
  const pullsGet = vi.fn(async () => ({
    data: { head: { sha: overrides.headSha ?? HEAD_SHA } },
  }));
  const listReviews = vi.fn(async () => ({
    data: overrides.reviews ?? [],
    headers: {},
  }));
  const createReview = vi.fn(async () => ({
    data: overrides.createReviewResponse ?? makeRawReview({ id: 99 }),
  }));
  const dismissReview = vi.fn(async () => ({
    data: makeRawReview({ id: 99, state: "DISMISSED" }),
  }));

  const octokit = {
    rest: {
      pulls: {
        get: pullsGet,
        listReviews,
        createReview,
        dismissReview,
      },
    },
  } as unknown as Octokit;

  return {
    octokit,
    pullsGet,
    listReviews,
    createReview,
    dismissReview,
  };
}

describe("createOctokitApprovalClient", () => {
  it("validates constructor options conservatively", () => {
    const { octokit } = makeMockOctokit();

    expect(() => createOctokitApprovalClient(octokit, { maxReviewPages: 0 })).toThrow(
      /maxReviewPages/,
    );
    expect(() => createOctokitApprovalClient(octokit, { maxReviewPages: 1.5 })).toThrow(
      /maxReviewPages/,
    );
    expect(() => createOctokitApprovalClient(octokit, { dismissMessage: "   " })).toThrow(
      /dismissMessage/,
    );
  });

  describe("getHeadSha", () => {
    it("fetches rest.pulls.get and returns validated head.sha", async () => {
      const { octokit, pullsGet } = makeMockOctokit({ headSha: HEAD_SHA });
      const client = createOctokitApprovalClient(octokit);

      const sha = await client.getHeadSha({ owner: "owner", repo: "repo", pullNumber: 42 });

      expect(sha).toBe(HEAD_SHA);
      expect(pullsGet).toHaveBeenCalledExactlyOnceWith({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
      });
    });

    it("supports direct octokit client without .rest wrapper", async () => {
      const pullsGet = vi.fn(async () => ({
        data: { head: { sha: HEAD_SHA } },
      }));
      const directOctokit = {
        pulls: {
          get: pullsGet,
          listReviews: vi.fn(),
          createReview: vi.fn(),
          dismissReview: vi.fn(),
        },
      } as unknown as Octokit;
      const client = createOctokitApprovalClient(directOctokit);

      const sha = await client.getHeadSha({ owner: "owner", repo: "repo", pullNumber: 42 });

      expect(sha).toBe(HEAD_SHA);
    });

    it.each([
      { data: {} },
      { data: { head: {} } },
      { data: { head: { sha: null } } },
      { data: { head: { sha: "" } } },
      { data: { head: { sha: "   " } } },
      { data: { head: { sha: "abc def" } } },
    ])("rejects invalid pulls.get payload %o", async (payload) => {
      const { octokit, pullsGet } = makeMockOctokit();
      pullsGet.mockResolvedValueOnce(payload as never);
      const client = createOctokitApprovalClient(octokit);

      await expect(
        client.getHeadSha({ owner: "owner", repo: "repo", pullNumber: 42 }),
      ).rejects.toThrow(/head\.sha/);
    });
  });

  describe("listReviews", () => {
    it("requests per_page=100 and maps review fields across closed states", async () => {
      const rawReviews = [
        makeRawReview({ id: 1, state: "APPROVED", user: { login: "alice" } }),
        makeRawReview({ id: 2, state: "CHANGES_REQUESTED", user: { login: "bob" } }),
        makeRawReview({ id: 3, state: "COMMENTED", user: { login: "carol" } }),
        makeRawReview({ id: 4, state: "DISMISSED", user: { login: "dave" } }),
        makeRawReview({ id: 5, state: "PENDING", user: { login: "eve" }, submitted_at: undefined }),
        makeRawReview({
          id: 6,
          state: "PENDING",
          user: { login: "frank" },
          submitted_at: "2026-11-26T12:30:00Z",
        }),
      ];
      const { octokit, listReviews } = makeMockOctokit({ reviews: rawReviews });
      const client = createOctokitApprovalClient(octokit);

      const reviews = await client.listReviews({ owner: "owner", repo: "repo", pullNumber: 42 });

      expect(listReviews).toHaveBeenCalledExactlyOnceWith({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        per_page: 100,
        page: 1,
      });
      expect(reviews).toEqual([
        {
          id: 1,
          author: "alice",
          commitId: HEAD_SHA,
          state: "APPROVED",
          submittedAt: "2026-11-26T12:00:00Z",
        },
        {
          id: 2,
          author: "bob",
          commitId: HEAD_SHA,
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-11-26T12:00:00Z",
        },
        {
          id: 3,
          author: "carol",
          commitId: HEAD_SHA,
          state: "COMMENTED",
          submittedAt: "2026-11-26T12:00:00Z",
        },
        {
          id: 4,
          author: "dave",
          commitId: HEAD_SHA,
          state: "DISMISSED",
          submittedAt: "2026-11-26T12:00:00Z",
        },
        {
          id: 5,
          author: "eve",
          commitId: HEAD_SHA,
          state: "PENDING",
          submittedAt: "",
        },
        {
          id: 6,
          author: "frank",
          commitId: HEAD_SHA,
          state: "PENDING",
          submittedAt: "2026-11-26T12:30:00Z",
        },
      ]);
    });

    it("paginates using Link headers within bounded page limit", async () => {
      const { octokit, listReviews } = makeMockOctokit();
      listReviews
        .mockResolvedValueOnce({
          data: [makeRawReview({ id: 1 })],
          headers: {
            link: '<https://api.github.com/repos/owner/repo/pulls/42/reviews?page=2>; rel="next"',
          },
        } as never)
        .mockResolvedValueOnce({
          data: [makeRawReview({ id: 2 })],
          headers: {
            link: '<https://api.github.com/repos/owner/repo/pulls/42/reviews?page=1>; rel="prev"',
          },
        } as never);
      const client = createOctokitApprovalClient(octokit, { maxReviewPages: 3 });

      const reviews = await client.listReviews({ owner: "owner", repo: "repo", pullNumber: 42 });

      expect(reviews.map((review) => review.id)).toEqual([1, 2]);
      expect(listReviews).toHaveBeenCalledTimes(2);
      expect(listReviews).toHaveBeenNthCalledWith(1, {
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        per_page: 100,
        page: 1,
      });
      expect(listReviews).toHaveBeenNthCalledWith(2, {
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        per_page: 100,
        page: 2,
      });
    });

    it("paginates full pages without Link headers and accepts exact page boundary when next page is empty", async () => {
      const pageOne = Array.from({ length: 100 }, (_, index) => makeRawReview({ id: index + 1 }));
      const pageTwo = Array.from({ length: 100 }, (_, index) => makeRawReview({ id: index + 101 }));
      const { octokit, listReviews } = makeMockOctokit();
      listReviews
        .mockResolvedValueOnce({ data: pageOne, headers: {} } as never)
        .mockResolvedValueOnce({ data: pageTwo, headers: {} } as never)
        .mockResolvedValueOnce({ data: [], headers: {} } as never);
      const client = createOctokitApprovalClient(octokit, { maxReviewPages: 2 });

      const reviews = await client.listReviews({ owner: "owner", repo: "repo", pullNumber: 42 });

      expect(reviews).toHaveLength(200);
      expect(listReviews).toHaveBeenCalledTimes(3);
    });

    it("rejects truncated results when Link rel=next persists at the page bound", async () => {
      const { octokit, listReviews } = makeMockOctokit();
      listReviews.mockResolvedValue({
        data: [makeRawReview({ id: 1 })],
        headers: {
          link: '<https://api.github.com/repos/owner/repo/pulls/42/reviews?page=11>; rel="next"',
        },
      } as never);
      const client = createOctokitApprovalClient(octokit);

      await expect(
        client.listReviews({ owner: "owner", repo: "repo", pullNumber: 42 }),
      ).rejects.toThrow(/maxReviewPages/);
      expect(listReviews).toHaveBeenCalledTimes(DEFAULT_MAX_REVIEW_PAGES);
    });

    it("rejects truncated results without Link headers when overflow page contains items", async () => {
      const fullPage = Array.from({ length: 100 }, (_, index) => makeRawReview({ id: index + 1 }));
      const { octokit, listReviews } = makeMockOctokit();
      listReviews
        .mockResolvedValueOnce({ data: fullPage, headers: {} } as never)
        .mockResolvedValueOnce({ data: [makeRawReview({ id: 101 })], headers: {} } as never);
      const client = createOctokitApprovalClient(octokit, { maxReviewPages: 1 });

      await expect(
        client.listReviews({ owner: "owner", repo: "repo", pullNumber: 42 }),
      ).rejects.toThrow(/maxReviewPages/);
    });

    it.each([
      { label: "non-array data", data: { invalid: true } },
      { label: "non-object element", data: ["bad"] },
      { label: "missing id", data: [makeRawReview({ id: 0 })] },
      { label: "missing user", data: [makeRawReview({ user: null })] },
      { label: "blank login", data: [makeRawReview({ user: { login: "   " } })] },
      { label: "unsupported state", data: [makeRawReview({ state: "UNKNOWN" })] },
      { label: "null commit_id", data: [makeRawReview({ commit_id: null })] },
      { label: "blank commit_id", data: [makeRawReview({ commit_id: "  " })] },
      {
        label: "missing submitted_at on approved",
        data: [makeRawReview({ submitted_at: undefined })],
      },
      {
        label: "invalid submitted_at on approved",
        data: [makeRawReview({ submitted_at: "not-a-date" })],
      },
      {
        label: "invalid submitted_at on pending",
        data: [makeRawReview({ state: "PENDING", submitted_at: "not-a-date" })],
      },
    ])("rejects invalid review response ($label)", async ({ data }) => {
      const { octokit, listReviews } = makeMockOctokit();
      listReviews.mockResolvedValueOnce({ data, headers: {} } as never);
      const client = createOctokitApprovalClient(octokit);

      await expect(
        client.listReviews({ owner: "owner", repo: "repo", pullNumber: 42 }),
      ).rejects.toThrow();
    });
  });

  describe("submitApproval", () => {
    it("invokes rest.pulls.createReview with event APPROVE and maps response", async () => {
      const { octokit, createReview } = makeMockOctokit({
        createReviewResponse: makeRawReview({
          id: 77,
          user: { login: DEFAULT_APPROVAL_AUTHOR },
          state: "APPROVED",
          commit_id: HEAD_SHA,
          submitted_at: "2026-11-26T12:05:00Z",
        }),
      });
      const client = createOctokitApprovalClient(octokit);

      const submitted = await client.submitApproval({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        commitId: HEAD_SHA,
        body: "Approved after policy satisfaction.",
      });

      expect(createReview).toHaveBeenCalledExactlyOnceWith({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        commit_id: HEAD_SHA,
        event: "APPROVE",
        body: "Approved after policy satisfaction.",
      });
      expect(submitted).toEqual({
        id: 77,
        author: DEFAULT_APPROVAL_AUTHOR,
        commitId: HEAD_SHA,
        state: "APPROVED",
        submittedAt: "2026-11-26T12:05:00Z",
      });
    });

    it("rejects blank commitId before calling GitHub API", async () => {
      const { octokit, createReview } = makeMockOctokit();
      const client = createOctokitApprovalClient(octokit);

      await expect(
        client.submitApproval({
          owner: "owner",
          repo: "repo",
          pullNumber: 42,
          commitId: " ",
          body: "Approved",
        }),
      ).rejects.toThrow(/commitId/);
      expect(createReview).not.toHaveBeenCalled();
    });
  });

  describe("dismissReview", () => {
    it("invokes rest.pulls.dismissReview with default and custom messages", async () => {
      const { octokit, dismissReview } = makeMockOctokit();
      const defaultClient = createOctokitApprovalClient(octokit);

      await defaultClient.dismissReview({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        reviewId: 12,
      });

      expect(dismissReview).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        review_id: 12,
        message: DEFAULT_DISMISS_MESSAGE,
      });

      const customClient = createOctokitApprovalClient(octokit, {
        dismissMessage: "Stale approval dismissed",
      });
      await customClient.dismissReview({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        reviewId: 13,
      });

      expect(dismissReview).toHaveBeenLastCalledWith({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        review_id: 13,
        message: "Stale approval dismissed",
      });
    });

    it("rejects non-positive reviewId before calling GitHub API", async () => {
      const { octokit, dismissReview } = makeMockOctokit();
      const client = createOctokitApprovalClient(octokit);

      await expect(
        client.dismissReview({ owner: "owner", repo: "repo", pullNumber: 42, reviewId: 0 }),
      ).rejects.toThrow(/reviewId/);
      expect(dismissReview).not.toHaveBeenCalled();
    });
  });

  describe("isOwnedReview", () => {
    it("fails closed when caller attestation is omitted, even with matching author login", () => {
      const { octokit } = makeMockOctokit();
      const client = createOctokitApprovalClient(octokit);

      expect(client.isOwnedReview(makeApprovalReview({ author: DEFAULT_APPROVAL_AUTHOR }))).toBe(
        false,
      );
    });

    it("requires both expectedAuthor match and true caller attestation", () => {
      const { octokit } = makeMockOctokit();
      const ownedIds = new Set([10]);
      const client = createOctokitApprovalClient(octokit, {
        expectedAuthor: "custom-bot[bot]",
        isOwnedReview: (review) => ownedIds.has(review.id),
      });

      expect(client.isOwnedReview(makeApprovalReview({ id: 10, author: "custom-bot[bot]" }))).toBe(
        true,
      );
      expect(client.isOwnedReview(makeApprovalReview({ id: 11, author: "custom-bot[bot]" }))).toBe(
        false,
      );
      expect(
        client.isOwnedReview(makeApprovalReview({ id: 10, author: DEFAULT_APPROVAL_AUTHOR })),
      ).toBe(false);
    });

    it("fails closed when expectedAuthor is blank", () => {
      const { octokit } = makeMockOctokit();
      const client = createOctokitApprovalClient(octokit, {
        expectedAuthor: "   ",
        isOwnedReview: () => true,
      });

      expect(client.isOwnedReview(makeApprovalReview({ author: "   " }))).toBe(false);
    });
  });

  describe("optional capability hooks", () => {
    it("omits optional hooks when not supplied and forwards them when supplied", async () => {
      const { octokit } = makeMockOctokit();
      const bareClient = createOctokitApprovalClient(octokit);

      expect(bareClient.requestCopilotReview).toBeUndefined();
      expect(bareClient.verifyBranchProtectionRecognition).toBeUndefined();

      const requestCopilotReview = vi.fn(async () => {});
      const verifyBranchProtectionRecognition = vi.fn(async () => true as const);
      const hookedClient = createOctokitApprovalClient(octokit, {
        requestCopilotReview,
        verifyBranchProtectionRecognition,
      });

      await hookedClient.requestCopilotReview?.({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha: HEAD_SHA,
        effort: "Balanced",
      });
      const recognized = await hookedClient.verifyBranchProtectionRecognition?.({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha: HEAD_SHA,
        reviewId: 55,
      });

      expect(requestCopilotReview).toHaveBeenCalledExactlyOnceWith({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha: HEAD_SHA,
        effort: "Balanced",
      });
      expect(verifyBranchProtectionRecognition).toHaveBeenCalledExactlyOnceWith({
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha: HEAD_SHA,
        reviewId: 55,
      });
      expect(recognized).toBe(true);
    });
  });
});

describe("publishPullRequestApproval", () => {
  it("submits github_app approval on PASS and verifies branch protection recognition", async () => {
    const { octokit, createReview } = makeMockOctokit();
    const verifyBranchProtectionRecognition = vi.fn(async () => true as const);
    const client = createOctokitApprovalClient(octokit, {
      isOwnedReview: (review) => review.id === 99,
      verifyBranchProtectionRecognition,
    });

    const outcome = await publishPullRequestApproval("github_app", client, makeApprovalInput());

    expect(outcome).toEqual({
      approvalStatus: "submitted",
      provider: "github_app",
      headSha: HEAD_SHA,
      countsTowardBranchProtection: "verified",
      reviewId: 99,
    });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        commit_id: HEAD_SHA,
        event: "APPROVE",
        body: expect.stringContaining(CHECK_RUN_URL),
      }),
    );
  });

  it("handles HTTP 422 self-approval cleanly without throwing", async () => {
    const { octokit, createReview } = makeMockOctokit();
    createReview.mockRejectedValueOnce({ status: 422 });
    const client = createOctokitApprovalClient(octokit, {
      isOwnedReview: () => true,
    });

    const outcome = await publishPullRequestApproval("github_app", client, makeApprovalInput());

    expect(outcome).toEqual({
      approvalStatus: "failed",
      provider: "github_app",
      headSha: HEAD_SHA,
      countsTowardBranchProtection: "unknown",
    });
  });

  it("aborts submission on stale head SHA", async () => {
    const { octokit, pullsGet, createReview } = makeMockOctokit();
    pullsGet.mockResolvedValueOnce({ data: { head: { sha: "newer-sha" } } });
    const client = createOctokitApprovalClient(octokit, {
      isOwnedReview: () => true,
    });

    const outcome = await publishPullRequestApproval("github_app", client, makeApprovalInput());

    expect(outcome).toEqual({
      approvalStatus: "failed",
      provider: "github_app",
      headSha: HEAD_SHA,
      countsTowardBranchProtection: "unknown",
    });
    expect(createReview).not.toHaveBeenCalled();
  });

  it.each(["FAIL", "PENDING"] as const)(
    "never dismisses unowned reviews with matching login on %s",
    async (verdict) => {
      const { octokit, dismissReview } = makeMockOctokit({
        reviews: [
          makeRawReview({ id: 1, user: { login: DEFAULT_APPROVAL_AUTHOR }, state: "APPROVED" }),
          makeRawReview({ id: 2, user: { login: DEFAULT_APPROVAL_AUTHOR }, state: "APPROVED" }),
        ],
      });

      const unattestedClient = createOctokitApprovalClient(octokit);
      const unattestedOutcome = await publishPullRequestApproval(
        "github_app",
        unattestedClient,
        makeApprovalInput({ verdict }),
      );

      expect(unattestedOutcome.approvalStatus).toBe("skipped_by_policy");
      expect(dismissReview).not.toHaveBeenCalled();

      const partialOwnedClient = createOctokitApprovalClient(octokit, {
        isOwnedReview: (review) => review.id === 2,
      });
      const partialOutcome = await publishPullRequestApproval(
        "github_app",
        partialOwnedClient,
        makeApprovalInput({ verdict }),
      );

      expect(partialOutcome.approvalStatus).toBe("skipped_by_policy");
      expect(dismissReview).toHaveBeenCalledExactlyOnceWith({
        owner: "owner",
        repo: "repo",
        pull_number: 42,
        review_id: 2,
        message: DEFAULT_DISMISS_MESSAGE,
      });
    },
  );

  it("integrates with github_copilot for existing approval and pending review request", async () => {
    const { octokit } = makeMockOctokit({
      reviews: [
        makeRawReview({
          id: 50,
          user: { login: "copilot-pull-request-reviewer[bot]" },
          state: "APPROVED",
          commit_id: HEAD_SHA,
        }),
      ],
    });
    const recognizedClient = createOctokitApprovalClient(octokit, {
      verifyBranchProtectionRecognition: vi.fn(async () => false as const),
    });

    const existingOutcome = await publishPullRequestApproval(
      "github_copilot",
      recognizedClient,
      makeApprovalInput(),
    );

    expect(existingOutcome).toEqual({
      approvalStatus: "verified_existing",
      provider: "github_copilot",
      headSha: HEAD_SHA,
      countsTowardBranchProtection: "not_applicable",
      reviewId: 50,
    });

    const emptyMock = makeMockOctokit({ reviews: [] });
    const requestCopilotReview = vi.fn(async () => {});
    const pendingClient = createOctokitApprovalClient(emptyMock.octokit, {
      requestCopilotReview,
    });

    const requestedOutcome = await publishPullRequestApproval(
      "github_copilot",
      pendingClient,
      makeApprovalInput({ resolvedEffort: "Max" }),
    );

    expect(requestedOutcome).toEqual({
      approvalStatus: "requested_pending",
      provider: "github_copilot",
      headSha: HEAD_SHA,
      countsTowardBranchProtection: "unknown",
    });
    expect(requestCopilotReview).toHaveBeenCalledExactlyOnceWith({
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha: HEAD_SHA,
      effort: "Max",
    });
  });

  it("integrates with none provider for eligible PASS and non-PASS dismissal", async () => {
    const { octokit, pullsGet, listReviews, createReview, dismissReview } = makeMockOctokit({
      reviews: [
        makeRawReview({ id: 7, user: { login: DEFAULT_APPROVAL_AUTHOR }, state: "APPROVED" }),
      ],
    });
    const client = createOctokitApprovalClient(octokit, {
      isOwnedReview: (review) => review.id === 7,
    });

    const passOutcome = await publishPullRequestApproval("none", client, makeApprovalInput());
    expect(passOutcome).toEqual({
      approvalStatus: "skipped_provider_none",
      provider: "none",
      headSha: HEAD_SHA,
      countsTowardBranchProtection: "unknown",
    });
    expect(pullsGet).not.toHaveBeenCalled();
    expect(listReviews).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
    expect(dismissReview).not.toHaveBeenCalled();

    const failOutcome = await publishPullRequestApproval(
      "none",
      client,
      makeApprovalInput({ verdict: "FAIL" }),
    );
    expect(failOutcome).toEqual({
      approvalStatus: "skipped_by_policy",
      provider: "none",
      headSha: HEAD_SHA,
      countsTowardBranchProtection: "unknown",
    });
    expect(dismissReview).toHaveBeenCalledTimes(1);
  });
});
