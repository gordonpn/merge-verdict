import { describe, expect, it } from "vitest";
import type {
  GitHubCheckRun,
  GitHubReviewSubmission,
} from "../../src/collector/github-collector.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { deepSeekNormalizer, normalizeDeepSeekReviewer } from "../../src/normalizers/deepseek.js";

describe("normalizeDeepSeekReviewer", () => {
  const headSha = "6ad1952e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c";

  it("exports adapter object matching ReviewerNormalizer interface", () => {
    expect(deepSeekNormalizer.reviewerId).toBe("deepseek-review");
    expect(deepSeekNormalizer.reviewerName).toBe("DeepSeek Review");
    const result = deepSeekNormalizer.normalize({ headSha });
    expect(result.status).toBe("PENDING");
  });

  it("returns PENDING when DeepSeek review is missing", () => {
    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
    expect(result.isFresh).toBe(false);
    expect(result.evaluatedCommitSha).toBeNull();
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("selects the latest review submission when multiple reviews exist", () => {
    const olderSha = "1111111111111111111111111111111111111111";
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 501,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: olderSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: APPROVE

### Material Findings
None.`,
        bodyDigest: "d1",
      },
      {
        id: 502,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T11:00:00Z",
        body: `## Verdict: BLOCK

### Material Findings
* Critical issue.`,
        bodyDigest: "d2",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings[0]?.severity).toBe("BLOCKER");
  });

  it("marks reviewer as STALE when review was generated against older commit", () => {
    const olderSha = "1111111111111111111111111111111111111111";
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 501,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: olderSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: APPROVE

### Material Findings
None.`,
        bodyDigest: "d1",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("STALE");
    expect(result.isFresh).toBe(false);
    expect(result.evaluatedCommitSha).toBe(olderSha);
    expect(result.verdict).toBe("NONE");
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("parses APPROVE WITH MINOR FINDINGS with advisory findings", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 502,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: APPROVE WITH MINOR FINDINGS

### Material Findings
* Minor typo in documentation comment.
* Consider adding unit test for empty slice.

### Unverified Assumptions
* Assumes Redis connection is always available.`,
        bodyDigest: "d2",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.severity).toBe("LOW");
    expect(result.findings[0]?.isBlocking).toBe(false);
    expect(result.findings[0]?.title).toBe("Minor typo in documentation comment.");
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("parses REQUEST CHANGES with blocking findings", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 503,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: REQUEST CHANGES

### Material Findings
* Unauthenticated admin route exposed without role check.`,
        bodyDigest: "d3",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("HIGH");
    expect(result.findings[0]?.isBlocking).toBe(true);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("parses multiline Verdict headings without a colon", () => {
    const requestChanges = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 510,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:00:00Z",
          body: `## Verdict

**REQUEST CHANGES**

### Material Findings
* Missing boundary guard.`,
          bodyDigest: "d10",
        },
      ],
    });

    expect(requestChanges.status).toBe("COMPLETED");
    expect(requestChanges.isFresh).toBe(true);
    expect(requestChanges.verdict).toBe("CHANGES_REQUESTED");
    expect(requestChanges.findings).toHaveLength(1);
    expect(requestChanges.findings[0]?.isBlocking).toBe(true);

    const approveMinor = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 511,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:01:00Z",
          body: `## Verdict:

**APPROVE WITH MINOR FINDINGS**`,
          bodyDigest: "d11",
        },
      ],
    });

    expect(approveMinor.status).toBe("COMPLETED");
    expect(approveMinor.verdict).toBe("APPROVE");
    expect(approveMinor.findings).toHaveLength(0);
  });

  it("parses BLOCK verdict with BLOCKER severity", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 504,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: BLOCK

### Material Findings
* Critical secret key committed in plain text.`,
        bodyDigest: "d4",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings[0]?.severity).toBe("BLOCKER");
    expect(result.findings[0]?.isBlocking).toBe(true);
  });

  it("returns COMMENTED when verdict heading is unrecognized", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 505,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: UNRECOGNIZED_STATUS

General commentary.`,
        bodyDigest: "d5",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("COMMENTED");
  });

  it("handles Material Findings section with 'None.' smoothly", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 506,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: APPROVE

### Material Findings
None.`,
        bodyDigest: "d6",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings).toHaveLength(0);
  });

  it("ignores review submissions from untrusted authors", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 507,
        reviewerLogin: "untrusted-contributor",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: APPROVE

### Material Findings
None.`,
        bodyDigest: "d7",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
    expect(result.isFresh).toBe(false);
  });

  it("prioritizes BLOCK over APPROVE when heading contains both words", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 508,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: BLOCK (do not approve)

### Material Findings
* Blocking issue found.`,
        bodyDigest: "d8",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("does not treat 'APPROVE (no blocking issues)' as a BLOCK verdict", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 509,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: `## Verdict: APPROVE (no blocking issues)

### Material Findings
None.`,
        bodyDigest: "d9",
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings).toHaveLength(0);
  });

  it.each<NonNullable<GitHubCheckRun["conclusion"]>>(["skipped", "neutral", "success"])(
    "classifies a completed %s check run on head SHA without a review as SKIPPED instead of PENDING unknown",
    (conclusion) => {
      const checkRuns: GitHubCheckRun[] = [
        {
          id: 133062762464,
          name: "runner / deepseek-review",
          status: "completed",
          conclusion,
          commitSha: headSha,
          startedAt: "2026-11-16T02:58:36Z",
          completedAt: "2026-11-16T02:58:38Z",
          detailsUrl: null,
          output: { title: null, summary: null, text: null },
        },
      ];

      const result = normalizeDeepSeekReviewer({
        headSha,
        checkRuns,
        reviewThreads: [],
        reviews: [],
        conversationComments: [],
      });

      expect(result.status).toBe("SKIPPED");
      expect(result.isFresh).toBe(true);
      expect(result.evaluatedCommitSha).toBe(headSha);
      expect(result.verdict).toBe("NONE");
      expect(result.checkRunConclusion).toBe(conclusion);
      expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
    },
  );

  it("classifies an in_progress check run on head SHA as PENDING with head SHA bound", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 133062762465,
        name: "runner / deepseek-review",
        status: "in_progress",
        conclusion: null,
        commitSha: headSha,
        startedAt: "2026-11-16T02:58:36Z",
        completedAt: null,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.isFresh).toBe(true);
    expect(result.evaluatedCommitSha).toBe(headSha);
    expect(result.verdict).toBe("NONE");
  });

  it("classifies a failing DeepSeek check run on head SHA without a review as FAILED", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 133062762466,
        name: "runner / deepseek-review",
        status: "completed",
        conclusion: "failure",
        commitSha: headSha,
        startedAt: "2026-11-16T02:58:36Z",
        completedAt: "2026-11-16T02:58:38Z",
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("FAILED");
    expect(result.isFresh).toBe(true);
    expect(result.evaluatedCommitSha).toBe(headSha);
    expect(result.verdict).toBe("NONE");
    expect(result.checkRunConclusion).toBe("failure");
  });

  it("marks an older commit check run without a fresh review as STALE", () => {
    const olderSha = "1111111111111111111111111111111111111111";
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 133062762467,
        name: "runner / deepseek-review",
        status: "completed",
        conclusion: "skipped",
        commitSha: olderSha,
        startedAt: "2026-11-16T02:58:36Z",
        completedAt: "2026-11-16T02:58:38Z",
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("STALE");
    expect(result.isFresh).toBe(false);
    expect(result.evaluatedCommitSha).toBe(olderSha);
    expect(result.verdict).toBe("NONE");
  });

  it("prefers fresh skipped check run over an older commit review", () => {
    const olderSha = "1111111111111111111111111111111111111111";
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 510,
        reviewerLogin: "github-actions[bot]",
        state: "COMMENTED",
        commitSha: olderSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "## Verdict: APPROVE\n\n### Material Findings\nNone.",
        bodyDigest: "d10",
      },
    ];
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 133062762468,
        name: "runner / deepseek-review",
        status: "completed",
        conclusion: "skipped",
        commitSha: headSha,
        startedAt: "2026-11-16T02:58:36Z",
        completedAt: "2026-11-16T02:58:38Z",
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
      },
    ];

    const result = normalizeDeepSeekReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("SKIPPED");
    expect(result.isFresh).toBe(true);
    expect(result.evaluatedCommitSha).toBe(headSha);
    expect(result.verdict).toBe("NONE");
  });
});
