import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalClient,
  type ApprovalInput,
  type ApprovalReview,
  createApprovalProvider,
} from "../../src/publisher/approval-provider.js";
import { publishAppApproval } from "../../src/publisher/providers/github-app.js";
import { publishCopilotApproval } from "../../src/publisher/providers/github-copilot.js";

const input: ApprovalInput = {
  owner: "o",
  repo: "r",
  pullNumber: 1,
  headSha: "abc",
  verdict: "PASS",
  pathEligible: true,
  checkRunUrl: "https://github.com/o/r/actions/runs/1",
};
const approval: ApprovalReview = {
  id: 1,
  author: "copilot-pull-request-reviewer[bot]",
  commitId: "abc",
  state: "APPROVED",
  submittedAt: "2026-11-01T00:00:00Z",
};
function client(reviews: ApprovalReview[] = []): ApprovalClient {
  return {
    getHeadSha: vi.fn(async () => "abc"),
    listReviews: vi.fn(async () => reviews),
    submitApproval: vi.fn(async () => ({ ...approval, author: "merge-verdict[bot]" })),
    dismissReview: vi.fn(async () => {}),
    isOwnedReview: (review) => review.author === "merge-verdict[bot]",
  };
}

describe("approval provider safety boundary", () => {
  it("strategy functions also refuse direct calls without PASS and explicit path eligibility", async () => {
    const api = client();
    api.requestCopilotReview = vi.fn(async () => {});
    expect((await publishAppApproval(api, { ...input, verdict: "FAIL" })).approvalStatus).toBe(
      "skipped_by_policy",
    );
    expect(
      (await publishCopilotApproval(api, { ...input, pathEligible: false })).approvalStatus,
    ).toBe("skipped_by_policy");
    expect(api.submitApproval).not.toHaveBeenCalled();
    expect(api.requestCopilotReview).not.toHaveBeenCalled();
  });
  it("forwards resolved effort only through the optional trusted capability", async () => {
    const api = client();
    api.requestCopilotReview = vi.fn(async () => {});
    await createApprovalProvider("github_copilot", api).publish({
      ...input,
      resolvedEffort: "Max",
    });
    expect(api.requestCopilotReview).toHaveBeenCalledWith(
      expect.objectContaining({ effort: "Max" }),
    );
  });
  it("reuses an owned current app approval rather than duplicating it", async () => {
    const api = client([{ ...approval, author: "merge-verdict[bot]" }]);
    expect((await createApprovalProvider("github_app", api).publish(input)).approvalStatus).toBe(
      "verified_existing",
    );
    expect(api.submitApproval).not.toHaveBeenCalled();
  });
  it("reports a head race after submission without claiming approval recognition", async () => {
    const api = client();
    api.getHeadSha = vi
      .fn()
      .mockResolvedValueOnce("abc")
      .mockResolvedValueOnce("abc")
      .mockResolvedValue("new");
    expect(await createApprovalProvider("github_app", api).publish(input)).toMatchObject({
      approvalStatus: "failed",
      countsTowardBranchProtection: "unknown",
    });
  });
  it("does not label malformed or mismatched submission responses as approved", async () => {
    const api = client();
    api.submitApproval = vi.fn(async () => ({
      ...approval,
      author: "merge-verdict[bot]",
      commitId: "wrong",
    }));
    expect((await createApprovalProvider("github_app", api).publish(input)).approvalStatus).toBe(
      "failed",
    );
  });

  it("eligible PASS with none performs no network operations", async () => {
    const api = client();
    expect(await createApprovalProvider("none", api).publish(input)).toMatchObject({
      approvalStatus: "skipped_provider_none",
      countsTowardBranchProtection: "unknown",
    });
    expect(api.getHeadSha).not.toHaveBeenCalled();
    expect(api.listReviews).not.toHaveBeenCalled();
    expect(api.dismissReview).not.toHaveBeenCalled();
    expect(api.submitApproval).not.toHaveBeenCalled();
  });
  it.each([
    { verdict: "FAIL" as const, pathEligible: true },
    { verdict: "PENDING" as const, pathEligible: true },
    { verdict: "STALE" as const, pathEligible: true },
    { verdict: "ERROR" as const, pathEligible: true },
    { verdict: "PASS" as const, pathEligible: false },
  ])(
    "none dismisses only owned approvals for $verdict with eligibility $pathEligible",
    async (overrides) => {
      const api = client([
        approval,
        { ...approval, id: 2, author: "human" },
        { ...approval, id: 3, author: "merge-verdict[bot]" },
      ]);
      api.requestCopilotReview = vi.fn(async () => {});
      expect(
        await createApprovalProvider("none", api).publish({ ...input, ...overrides }),
      ).toMatchObject({
        provider: "none",
        approvalStatus: "skipped_by_policy",
        countsTowardBranchProtection: "unknown",
      });
      expect(api.dismissReview).toHaveBeenCalledExactlyOnceWith({
        owner: "o",
        repo: "r",
        pullNumber: 1,
        reviewId: 3,
      });
      expect(api.getHeadSha).not.toHaveBeenCalled();
      expect(api.submitApproval).not.toHaveBeenCalled();
      expect(api.requestCopilotReview).not.toHaveBeenCalled();
    },
  );
  it.each(["FAIL", "PENDING", "STALE", "ERROR"] as const)(
    "never requests or emits on %s and dismisses only owned approvals",
    async (verdict) => {
      const api = client([
        approval,
        { ...approval, id: 2, author: "human" },
        { ...approval, id: 3, author: "merge-verdict[bot]" },
      ]);
      api.requestCopilotReview = vi.fn(async () => {});
      await createApprovalProvider("github_copilot", api).publish({ ...input, verdict });
      expect(api.submitApproval).not.toHaveBeenCalled();
      expect(api.requestCopilotReview).not.toHaveBeenCalled();
      expect(api.dismissReview).toHaveBeenCalledExactlyOnceWith({
        owner: "o",
        repo: "r",
        pullNumber: 1,
        reviewId: 3,
      });
    },
  );
  it("requires explicit eligibility", async () => {
    const api = client();
    expect(
      (await createApprovalProvider("github_app", api).publish({ ...input, pathEligible: false }))
        .approvalStatus,
    ).toBe("skipped_by_policy");
    expect(api.submitApproval).not.toHaveBeenCalled();
  });
  it("preflights the head before submitting a SHA-bound app review", async () => {
    const api = client();
    expect((await createApprovalProvider("github_app", api).publish(input)).approvalStatus).toBe(
      "submitted",
    );
    expect(api.submitApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        commitId: "abc",
        body: expect.stringContaining(input.checkRunUrl),
      }),
    );
    expect(
      (await createApprovalProvider("github_app", api).publish(input)).countsTowardBranchProtection,
    ).toBe("unknown");
    const moved = client();
    moved.getHeadSha = vi.fn(async () => "new");
    expect((await createApprovalProvider("github_app", moved).publish(input)).approvalStatus).toBe(
      "failed",
    );
    expect(moved.submitApproval).not.toHaveBeenCalled();
  });
  it("does not infer approval from a rejected app response or HTTP 422", async () => {
    const api = client();
    api.submitApproval = vi.fn(async () => {
      throw { status: 422 };
    });
    expect(await createApprovalProvider("github_app", api).publish(input)).toMatchObject({
      approvalStatus: "failed",
      countsTowardBranchProtection: "unknown",
    });
  });
  it("recognizes only active current-head Copilot approval and evidence-bound protection recognition", async () => {
    const api = client([approval]);
    api.verifyBranchProtectionRecognition = vi.fn(async () => true);
    expect(await createApprovalProvider("github_copilot", api).publish(input)).toMatchObject({
      approvalStatus: "verified_existing",
      countsTowardBranchProtection: "verified",
    });
    expect(api.verifyBranchProtectionRecognition).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: 1, headSha: "abc" }),
    );
  });
  it.each(
    [
      [{ ...approval, state: "DISMISSED" as const }],
      [{ ...approval, commitId: "old" }],
      [
        approval,
        {
          ...approval,
          id: 2,
          state: "CHANGES_REQUESTED" as const,
          submittedAt: "2026-11-02T00:00:00Z",
        },
      ],
      [
        approval,
        { ...approval, id: 2, state: "COMMENTED" as const, submittedAt: "2026-11-02T00:00:00Z" },
      ],
      [{ ...approval, author: "human" }],
    ].map((reviews) => ({ reviews })),
  )(
    "does not count dismissed, stale, superseded, or unrelated reviews: $reviews",
    async ({ reviews }) => {
      const api = client(reviews);
      expect(
        (await createApprovalProvider("github_copilot", api).publish(input)).approvalStatus,
      ).toBe("failed");
    },
  );
  it("uses an optional injected Copilot request and never treats a request as approval", async () => {
    const api = client();
    api.requestCopilotReview = vi.fn(async () => {});
    expect(await createApprovalProvider("github_copilot", api).publish(input)).toMatchObject({
      approvalStatus: "requested_pending",
      countsTowardBranchProtection: "unknown",
    });
    expect(api.requestCopilotReview).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: "abc" }),
    );
  });
  it("rechecks head after review reads to close the preflight read window", async () => {
    const api = client([approval]);
    api.getHeadSha = vi.fn().mockResolvedValueOnce("abc").mockResolvedValue("new");
    expect(
      (await createApprovalProvider("github_copilot", api).publish(input)).approvalStatus,
    ).toBe("failed");
  });
  it("propagates unexpected API failures rather than implying success", async () => {
    const api = client();
    api.submitApproval = vi.fn(async () => {
      throw new Error("network");
    });
    await expect(createApprovalProvider("github_app", api).publish(input)).rejects.toThrow(
      "network",
    );
  });
});
