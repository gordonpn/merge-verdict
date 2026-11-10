import { describe, expect, it } from "vitest";
import type {
  GitHubCheckRun,
  GitHubReviewSubmission,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { normalizeSourceryReviewer, sourceryNormalizer } from "../../src/normalizers/sourcery.js";

describe("normalizeSourceryReviewer", () => {
  const headSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("exports adapter object matching ReviewerNormalizer interface", () => {
    expect(sourceryNormalizer.reviewerId).toBe("sourcery-ai");
    expect(sourceryNormalizer.reviewerName).toBe("Sourcery");
    const result = sourceryNormalizer.normalize({ headSha });
    expect(result.status).toBe("PENDING");
  });

  it("returns PENDING when Sourcery has not executed", () => {
    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
    expect(result.isFresh).toBe(false);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("returns PENDING when check run is in_progress", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 10,
        name: "Sourcery review",
        status: "in_progress",
        conclusion: null,
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
  });

  it("returns FAILED and CHANGES_REQUESTED when check run conclusion is failure", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 11,
        name: "Sourcery review",
        status: "completed",
        conclusion: "failure",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("rejects neutral check run as FAILED rather than APPROVE", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 111,
        name: "Sourcery review",
        status: "completed",
        conclusion: "neutral",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("NONE");
  });

  it("preserves active CHANGES_REQUESTED review submission even with zero inline threads", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 112,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 301,
        reviewerLogin: "sourcery-ai[bot]",
        state: "CHANGES_REQUESTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "Changes needed.",
        bodyDigest: "d1",
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("flags older check run evaluations as STALE", () => {
    const olderSha = "0000000000000000000000000000000000000000";
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 12,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: olderSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("STALE");
    expect(result.isFresh).toBe(false);
    expect(result.evaluatedCommitSha).toBe(olderSha);
  });

  it("normalizes High/Medium/Low findings and addressed commit acknowledgements", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 13,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_sourcery_1",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/utils.ts",
        line: 12,
        originalLine: 12,
        comments: [
          {
            id: "c1",
            authorLogin: "sourcery-ai[bot]",
            body: "High · Previous defaults carry over\n\nReset default configuration on each invocation.",
            bodyDigest: "d1",
            path: "src/utils.ts",
            line: 12,
            originalLine: 12,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_sourcery_2",
        isResolved: true,
        resolvedByLogin: "sourcery-ai[bot]",
        isOutdated: false,
        path: "src/utils.ts",
        line: 30,
        originalLine: 30,
        comments: [
          {
            id: "c2",
            authorLogin: "sourcery-ai[bot]",
            body: "Addressed in [f1e2d3c4]: First match passes mode test\n\nMedium · First match passes mode test",
            bodyDigest: "d2",
            path: "src/utils.ts",
            line: 30,
            originalLine: 30,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_sourcery_3",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/utils.ts",
        line: 45,
        originalLine: 45,
        comments: [
          {
            id: "c3",
            authorLogin: "sourcery-ai[bot]",
            body: "Low · Prefer const over let\n\nVariable is not reassigned.",
            bodyDigest: "d3",
            path: "src/utils.ts",
            line: 45,
            originalLine: 45,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads,
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED"); // thread_sourcery_1 is unresolved High
    expect(result.findings).toHaveLength(3);

    const [f1, f2, f3] = result.findings;
    expect(f1?.severity).toBe("HIGH");
    expect(f1?.isBlocking).toBe(true);
    expect(f1?.title).toBe("Previous defaults carry over");

    expect(f2?.severity).toBe("MEDIUM");
    expect(f2?.isResolved).toBe(true);
    expect(f2?.isBlocking).toBe(false);
    expect(f2?.acknowledgedCommitSha).toBe("f1e2d3c4");
    expect(f2?.resolvedBy).toBe("sourcery-ai[bot]");

    expect(f3?.severity).toBe("LOW");
    expect(f3?.isBlocking).toBe(false);

    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("returns APPROVE when all findings are resolved and check run is successful", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 14,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_sourcery_resolved",
        isResolved: true,
        resolvedByLogin: "sourcery-ai[bot]",
        isOutdated: false,
        path: "src/utils.ts",
        line: 10,
        originalLine: 10,
        comments: [
          {
            id: "c4",
            authorLogin: "sourcery-ai[bot]",
            body: "Addressed in [e9d8c7b6]: High · Fixed memory leak",
            bodyDigest: "d4",
            path: "src/utils.ts",
            line: 10,
            originalLine: 10,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads,
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings[0]?.isResolved).toBe(true);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("treats acknowledged finding as unresolved when acknowledged SHA is not in ancestry", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 15,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_sourcery_bad_sha",
        isResolved: true,
        resolvedByLogin: "sourcery-ai[bot]",
        isOutdated: false,
        path: "src/utils.ts",
        line: 10,
        originalLine: 10,
        comments: [
          {
            id: "c5",
            authorLogin: "sourcery-ai[bot]",
            body: "Addressed in [badc0ffee123]: High · Fixed bug",
            bodyDigest: "d5",
            path: "src/utils.ts",
            line: 10,
            originalLine: 10,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      ancestorCommitShas: ["baseSha123", headSha],
      checkRuns,
      reviewThreads,
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings[0]?.isResolved).toBe(false);
    expect(result.findings[0]?.isBlocking).toBe(true);
  });
});
