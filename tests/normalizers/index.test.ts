import { describe, expect, it } from "vitest";
import type { GitHubPullRequestData } from "../../src/collector/github-collector.js";
import { ReviewSnapshotSchema } from "../../src/models/snapshot.js";
import {
  buildReviewSnapshotFromPullRequest,
  DEFAULT_REVIEWER_NORMALIZERS,
} from "../../src/normalizers/index.js";

describe("buildReviewSnapshotFromPullRequest", () => {
  const headSha = "1234567890abcdef1234567890abcdef12345678";
  const baseSha = "abcdef1234567890abcdef1234567890abcdef12";

  const samplePrData: GitHubPullRequestData & { readonly isFork: boolean } = {
    repository: "gordonpn/merge-verdict",
    pullRequestNumber: 100,
    headSha,
    baseSha,
    headRef: "feat/sample",
    baseRef: "main",
    isFork: false,
    isDraft: false,
    mergeable: true,
    authorLogin: "gordonpn",
    evaluationSha: headSha,
    policyVersion: baseSha,
    changedFilePaths: ["src/index.ts"],
    reviewThreads: [],
    conversationComments: [],
    reviews: [],
    checkRuns: [
      {
        id: 1,
        name: "CodeRabbit",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: "Passed", text: null },
        startedAt: null,
        completedAt: null,
      },
    ],
    commitStatuses: [],
    policyContent: "required_checks: []",
  };

  it("creates a valid ReviewSnapshot using default normalizers", () => {
    const snapshot = buildReviewSnapshotFromPullRequest(samplePrData, {
      capturedAt: "2026-10-01T12:00:00.000Z",
    });

    expect(snapshot.repository).toBe("gordonpn/merge-verdict");
    expect(snapshot.pullRequestNumber).toBe(100);
    expect(snapshot.headSha).toBe(headSha);
    expect(snapshot.baseSha).toBe(baseSha);
    expect(snapshot.isDraft).toBe(false);
    expect(snapshot.unresolvedThreadCount).toBe(0);
    expect(snapshot.blockingDecisionCount).toBe(0);
    expect(snapshot.capturedAt).toBe("2026-10-01T12:00:00.000Z");

    expect(snapshot.reviewers.coderabbitai?.status).toBe("COMPLETED");
    expect(snapshot.reviewers.coderabbitai?.verdict).toBe("APPROVE");
    expect(snapshot.reviewers["sourcery-ai"]?.status).toBe("PENDING");
    expect(snapshot.reviewers["chatgpt-codex-connector"]?.status).toBe("PENDING");
    expect(snapshot.reviewers["deepseek-review"]?.status).toBe("PENDING");
    expect(snapshot.reviewers.copilot?.status).toBe("PENDING");

    expect(snapshot.checkRuns.CodeRabbit?.conclusion).toBe("success");
    expect(snapshot.stateFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const parseResult = ReviewSnapshotSchema.safeParse(snapshot);
    expect(parseResult.success).toBe(true);
  });

  it("calculates unresolvedThreadCount and blockingDecisionCount correctly", () => {
    const prWithIssues: GitHubPullRequestData = {
      ...samplePrData,
      reviewThreads: [
        {
          id: "thread_1",
          isResolved: false,
          resolvedByLogin: null,
          isOutdated: false,
          path: "src/index.ts",
          line: 10,
          originalLine: 10,
          comments: [
            {
              id: "c1",
              authorLogin: "copilot-pull-request-reviewer[bot]",
              body: "Issue found.",
              bodyDigest: "d1",
              path: "src/index.ts",
              line: 10,
              originalLine: 10,
              commitSha: headSha,
              createdAt: "2026-10-01T10:00:00Z",
              updatedAt: "2026-10-01T10:00:00Z",
            },
          ],
        },
      ],
      reviews: [
        {
          id: 50,
          reviewerLogin: "copilot-pull-request-reviewer[bot]",
          state: "CHANGES_REQUESTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:00:00Z",
          body: "Please fix issue.",
          bodyDigest: "d2",
        },
      ],
    };

    const snapshot = buildReviewSnapshotFromPullRequest(prWithIssues);
    expect(snapshot.unresolvedThreadCount).toBe(1);
    expect(snapshot.blockingDecisionCount).toBe(1);
    expect(snapshot.reviewers.copilot?.verdict).toBe("CHANGES_REQUESTED");
  });

  it("counts CHANGES_REQUESTED from human reviewers without a normalizer", () => {
    const prWithHumanReview: GitHubPullRequestData = {
      ...samplePrData,
      reviews: [
        {
          id: 51,
          reviewerLogin: "human-maintainer",
          state: "CHANGES_REQUESTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:00:00Z",
          body: "Architecture changes needed.",
          bodyDigest: "d51",
        },
      ],
    };

    const snapshot = buildReviewSnapshotFromPullRequest(prWithHumanReview);
    expect(snapshot.blockingDecisionCount).toBe(1);
  });

  it("sorts review submissions chronologically so later reviews supersede earlier ones", () => {
    const prWithSuccessiveReviews: GitHubPullRequestData = {
      ...samplePrData,
      reviews: [
        {
          id: 61,
          reviewerLogin: "human-maintainer",
          state: "APPROVED",
          commitSha: headSha,
          submittedAt: "2026-10-01T12:00:00Z",
          body: "Looks good now.",
          bodyDigest: "d61",
        },
        {
          id: 60,
          reviewerLogin: "human-maintainer",
          state: "CHANGES_REQUESTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:00:00Z",
          body: "Initial blockers.",
          bodyDigest: "d60",
        },
      ],
    };

    const snapshot = buildReviewSnapshotFromPullRequest(prWithSuccessiveReviews);
    expect(snapshot.blockingDecisionCount).toBe(0);
  });

  it("exports default normalizers list", () => {
    expect(DEFAULT_REVIEWER_NORMALIZERS).toHaveLength(5);
  });
});
