import { describe, expect, it } from "vitest";
import type {
  GitHubReviewSubmission,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { copilotNormalizer, normalizeCopilotReviewer } from "../../src/normalizers/copilot.js";

describe("normalizeCopilotReviewer", () => {
  const headSha = "9876543210fedcba9876543210fedcba98765432";

  it("exports adapter object matching ReviewerNormalizer interface", () => {
    expect(copilotNormalizer.reviewerId).toBe("copilot");
    expect(copilotNormalizer.reviewerName).toBe("GitHub Copilot");
    const result = copilotNormalizer.normalize({ headSha });
    expect(result.status).toBe("PENDING");
  });

  it("returns PENDING when Copilot has not submitted a review or comments", () => {
    const result = normalizeCopilotReviewer({
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

  it("marks reviewer as STALE when review targets an older commit SHA", () => {
    const olderSha = "0000000000000000000000000000000000000000";
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 301,
        reviewerLogin: "copilot-pull-request-reviewer[bot]",
        state: "APPROVED",
        commitSha: olderSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "All checks passed. Ready for merge.",
        bodyDigest: "d1",
      },
    ];

    const result = normalizeCopilotReviewer({
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

  it("returns COMPLETED, isFresh: true, and APPROVE when Copilot approves head SHA with zero unresolved threads", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 302,
        reviewerLogin: "copilot-pull-request-reviewer[bot]",
        state: "APPROVED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "No potential issues found. LGTM.",
        bodyDigest: "d2",
      },
    ];

    const result = normalizeCopilotReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings).toEqual([]);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("returns COMPLETED and COMMENTED when Copilot submits COMMENTED review with zero unresolved threads", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 3025,
        reviewerLogin: "copilot-pull-request-reviewer[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "Review finished. Advisory notes only.",
        bodyDigest: "d25",
      },
    ];

    const result = normalizeCopilotReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("COMMENTED");
  });

  it("returns NONE verdict when review state is DISMISSED or unrecognized", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 3026,
        reviewerLogin: "copilot-pull-request-reviewer[bot]",
        state: "DISMISSED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: null,
        bodyDigest: null,
      },
    ];

    const result = normalizeCopilotReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("NONE");
  });

  it("normalizes unresolved inline threads into blocking NormalizedFinding objects", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 303,
        reviewerLogin: "copilot-pull-request-reviewer[bot]",
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "Review completed with comments.",
        bodyDigest: "d3",
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "copilot_t1",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/api/auth.ts",
        line: 15,
        originalLine: 15,
        comments: [
          {
            id: "c1",
            authorLogin: "copilot-pull-request-reviewer[bot]",
            body: "Ensure token is validated against signing key.",
            bodyDigest: "d1",
            path: "src/api/auth.ts",
            line: 15,
            originalLine: 15,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "copilot_t2",
        isResolved: true,
        resolvedByLogin: "gordonpn",
        isOutdated: false,
        path: "src/api/auth.ts",
        line: 25,
        originalLine: 25,
        comments: [
          {
            id: "c2",
            authorLogin: "copilot-pull-request-reviewer",
            body: "Consider renaming variable.",
            bodyDigest: "d2",
            path: "src/api/auth.ts",
            line: 25,
            originalLine: 25,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeCopilotReviewer({
      headSha,
      checkRuns: [],
      reviewThreads,
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED"); // Unresolved thread makes verdict CHANGES_REQUESTED
    expect(result.findings).toHaveLength(2);

    const [f1, f2] = result.findings;
    expect(f1?.threadId).toBe("copilot_t1");
    expect(f1?.filePath).toBe("src/api/auth.ts");
    expect(f1?.lineNumber).toBe(15);
    expect(f1?.severity).toBe("HIGH");
    expect(f1?.isBlocking).toBe(true);
    expect(f1?.isResolved).toBe(false);

    expect(f2?.threadId).toBe("copilot_t2");
    expect(f2?.isResolved).toBe(true);
    expect(f2?.isBlocking).toBe(false);
    expect(f2?.resolvedBy).toBe("gordonpn");
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("handles CHANGES_REQUESTED review state", () => {
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 304,
        reviewerLogin: "copilot-pull-request-reviewer[bot]",
        state: "CHANGES_REQUESTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "Please address requested changes.",
        bodyDigest: "d4",
      },
    ];

    const result = normalizeCopilotReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("populates commit permalinks and handles thread title fallbacks and null authors", () => {
    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_permalink",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/server.ts",
        line: 42,
        originalLine: 42,
        comments: [
          {
            id: "cp1",
            authorLogin: "copilot-pull-request-reviewer",
            body: "<!-- comment marker -->\n> quote line\nActual issue title here.",
            bodyDigest: "d_p",
            path: "src/server.ts",
            line: 42,
            originalLine: 42,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_fallback_title",
        isResolved: true,
        resolvedByLogin: "copilot-pull-request-reviewer[bot]",
        isOutdated: false,
        path: "src/db.ts",
        line: 10,
        originalLine: 10,
        comments: [
          {
            id: "cp2",
            authorLogin: "copilot-pull-request-reviewer[bot]",
            body: "###\n<!-- only hidden comment -->",
            bodyDigest: "d_f",
            path: "src/db.ts",
            line: 10,
            originalLine: 10,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_no_path_fallback",
        isResolved: true,
        resolvedByLogin: null,
        isOutdated: false,
        path: null,
        line: null,
        originalLine: null,
        comments: [
          {
            id: "cp3",
            authorLogin: "copilot-pull-request-reviewer[bot]",
            body: "> only quote",
            bodyDigest: "d_f2",
            path: null,
            line: null,
            originalLine: null,
            commitSha: null,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_long_title",
        isResolved: true,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/long.ts",
        line: null,
        originalLine: null,
        comments: [
          {
            id: "cp3b",
            authorLogin: "copilot-pull-request-reviewer[bot]",
            body: "A".repeat(150),
            bodyDigest: "d_long",
            path: "src/long.ts",
            line: null,
            originalLine: null,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_empty_comments",
        isResolved: true,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/empty.ts",
        line: 1,
        originalLine: 1,
        comments: [],
      },
      {
        id: "thread_null_author",
        isResolved: true,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/null.ts",
        line: 1,
        originalLine: 1,
        comments: [
          {
            id: "cp4",
            authorLogin: null,
            body: "Anonymous comment",
            bodyDigest: "d_null",
            path: "src/null.ts",
            line: 1,
            originalLine: 1,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const reviews: GitHubReviewSubmission[] = [
      {
        id: 305,
        reviewerLogin: null,
        state: "COMMENTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "Anonymous review",
        bodyDigest: "d_anon",
      },
    ];

    const result = normalizeCopilotReviewer({
      headSha,
      repository: "gordonpn/merge-verdict",
      checkRuns: [],
      reviewThreads,
      reviews,
      conversationComments: [],
    });

    expect(result.findings).toHaveLength(4);
    const [f1, f2, f3, f4] = result.findings;
    expect(f1?.title).toBe("Actual issue title here.");
    expect(f1?.rawCommentUrl).toBe(
      `https://github.com/gordonpn/merge-verdict/blob/${headSha}/src/server.ts#L42`,
    );
    expect(f2?.title).toBe("Copilot finding on src/db.ts:10");
    expect(f3?.title).toBe("Copilot finding");
    expect(f4?.title.endsWith("...")).toBe(true);
    expect(f4?.title).toHaveLength(120);
  });
});
