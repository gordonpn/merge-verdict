import { describe, expect, it } from "vitest";
import type {
  GitHubCheckRun,
  GitHubConversationComment,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import {
  codeRabbitNormalizer,
  normalizeCodeRabbitReviewer,
} from "../../src/normalizers/coderabbit.js";

describe("normalizeCodeRabbitReviewer", () => {
  const headSha = "0123456789abcdef0123456789abcdef01234567";

  it("exports adapter object matching ReviewerNormalizer interface", () => {
    expect(codeRabbitNormalizer.reviewerId).toBe("coderabbitai");
    expect(codeRabbitNormalizer.reviewerName).toBe("CodeRabbit");
    const result = codeRabbitNormalizer.normalize({ headSha });
    expect(result.status).toBe("PENDING");
  });

  it("returns PENDING when CodeRabbit has not executed", () => {
    const result = normalizeCodeRabbitReviewer({
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
    expect(result.findings).toEqual([]);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("classifies neutral check run with review limit message as RATE_LIMITED", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 1,
        name: "CodeRabbit",
        status: "completed",
        conclusion: "neutral",
        commitSha: headSha,
        detailsUrl: null,
        output: {
          title: "CodeRabbit Review",
          summary:
            "Review limit reached. You've used all free OSS reviews for now. Wait for the free limit to reset to keep reviewing this public repository.",
          text: null,
        },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeCodeRabbitReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("RATE_LIMITED");
    expect(result.isFresh).toBe(false);
    expect(result.verdict).toBe("NONE");
    expect(result.checkRunConclusion).toBe("neutral");
    expect(result.findings).toEqual([]);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("classifies rate limit comment marker in conversation comment as RATE_LIMITED", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 2,
        name: "CodeRabbit",
        status: "completed",
        conclusion: "neutral",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 99,
        authorLogin: "coderabbitai[bot]",
        body: "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\nFree review limit exceeded.",
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodeRabbitReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("RATE_LIMITED");
    expect(result.isFresh).toBe(false);
  });

  it("returns PENDING when check run is in_progress or queued", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 10,
        name: "CodeRabbit",
        status: "in_progress",
        conclusion: null,
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeCodeRabbitReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
    expect(result.isFresh).toBe(true);
  });

  it("returns FAILED and CHANGES_REQUESTED when check run conclusion is failure", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 11,
        name: "CodeRabbit",
        status: "completed",
        conclusion: "failure",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: "Checks failed", text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeCodeRabbitReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("flags evaluation as STALE when check run evaluated an older commit", () => {
    const olderSha = "oldsha0000000000000000000000000000000000";
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 3,
        name: "CodeRabbit",
        status: "completed",
        conclusion: "success",
        commitSha: olderSha,
        detailsUrl: null,
        output: { title: null, summary: "Review completed.", text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeCodeRabbitReviewer({
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

  it("normalizes inline findings and ignores walkthrough summary comments", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 4,
        name: "CodeRabbit",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: "Completed with comments", text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_summary",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "README.md",
        line: 1,
        originalLine: 1,
        comments: [
          {
            id: "c_summary",
            authorLogin: "coderabbitai[bot]",
            body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n# Summary of changes",
            bodyDigest: "ds",
            path: "README.md",
            line: 1,
            originalLine: 1,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_1",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/auth/jwt.ts",
        line: 42,
        originalLine: 42,
        comments: [
          {
            id: "comment_1",
            authorLogin: "coderabbitai[bot]",
            body: "Potential issue:\n\nMissing expiration verification in token validation.",
            bodyDigest: "d1",
            path: "src/auth/jwt.ts",
            line: 42,
            originalLine: 42,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_2",
        isResolved: true,
        resolvedByLogin: "gordonpn",
        isOutdated: false,
        path: "src/auth/jwt.ts",
        line: 55,
        originalLine: 55,
        comments: [
          {
            id: "comment_2",
            authorLogin: "coderabbitai[bot]",
            body: "Refactor suggestion:\n\nConsider caching decoded header.",
            bodyDigest: "d2",
            path: "src/auth/jwt.ts",
            line: 55,
            originalLine: 55,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_3",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/auth/jwt.ts",
        line: 70,
        originalLine: 70,
        comments: [
          {
            id: "comment_3",
            authorLogin: "coderabbitai[bot]",
            body: "Critical security vulnerability in hash algorithm.",
            bodyDigest: "d3",
            path: "src/auth/jwt.ts",
            line: 70,
            originalLine: 70,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_4",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/auth/jwt.ts",
        line: 85,
        originalLine: 85,
        comments: [
          {
            id: "comment_4",
            authorLogin: "coderabbitai[bot]",
            body: "Nitpick style formatting issue.",
            bodyDigest: "d4",
            path: "src/auth/jwt.ts",
            line: 85,
            originalLine: 85,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeCodeRabbitReviewer({
      headSha,
      checkRuns,
      reviewThreads,
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings).toHaveLength(4);

    const [f1, f2, f3, f4] = result.findings;
    expect(f1?.severity).toBe("HIGH");
    expect(f1?.isBlocking).toBe(true);

    expect(f2?.severity).toBe("MEDIUM");
    expect(f2?.isBlocking).toBe(false);

    expect(f3?.severity).toBe("BLOCKER");
    expect(f3?.isBlocking).toBe(true);

    expect(f4?.severity).toBe("LOW");
    expect(f4?.isBlocking).toBe(false);
  });

  it("normalizes fresh successful check run without findings as APPROVE", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 5,
        name: "CodeRabbit",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: "No issues found.", text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeCodeRabbitReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings).toHaveLength(0);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });
});
