import { describe, expect, it } from "vitest";
import type {
  GitHubConversationComment,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { codexNormalizer, normalizeCodexReviewer } from "../../src/normalizers/codex.js";

describe("normalizeCodexReviewer", () => {
  const headSha = "35c286dc84db8dc22ffd3e58b3457a1c77acb019";

  it("exports adapter object matching ReviewerNormalizer interface", () => {
    expect(codexNormalizer.reviewerId).toBe("chatgpt-codex-connector");
    expect(codexNormalizer.reviewerName).toBe("Codex Reviewer");
    const result = codexNormalizer.normalize({ headSha });
    expect(result.status).toBe("PENDING");
  });

  it("returns PENDING when Codex state comment is absent", () => {
    const result = normalizeCodexReviewer({
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

  it("selects the latest state comment when multiple state comments exist", () => {
    const olderSha = "0000000000000000000000000000000000000000";
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 1,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${olderSha}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"}} -->`,
        bodyDigest: "d1",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
      {
        id: 2,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"}} -->`,
        bodyDigest: "d2",
        createdAt: "2026-10-01T11:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.evaluatedCommitSha).toBe(headSha);
  });

  it("does not reuse old approval after a newer invalid state", () => {
    const conversationComments: GitHubConversationComment[] = [false, "true"].map(
      (unresolved, index) => ({
        id: index,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: headSha, status: "completed", has_unresolved_findings: unresolved } })} -->`,
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      }),
    );
    const result = normalizeCodexReviewer({ headSha, conversationComments });
    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
  });

  it.each([
    { commit_sha: 123, has_unresolved_findings: false },
    { commit_sha: headSha, has_unresolved_findings: "true" },
    { commit_sha: headSha, has_any_findings: "false" },
    { commit_sha: headSha, status: 123 },
  ])("ignores state JSON with invalid field types: %j", (fields) => {
    const result = normalizeCodexReviewer({
      headSha,
      conversationComments: [
        {
          id: 100,
          authorLogin: "chatgpt-codex-connector[bot]",
          body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status: "completed", ...fields } })} -->`,
          bodyDigest: "digest",
          createdAt: "2026-10-01T10:00:00Z",
          updatedAt: null,
        },
      ],
    });
    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
    expect(result.evaluatedCommitSha).toBeNull();
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("handles malformed JSON in state comment gracefully as PENDING", () => {
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 99,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: "<!-- codex-review-state:v1 {malformed-json -->",
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
  });

  it("returns PENDING when Codex code review status is in_progress", () => {
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 100,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","status":"in_progress"}} -->`,
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
  });

  it("returns FAILED and CHANGES_REQUESTED when Codex code review status is failed", () => {
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 101,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","status":"failed"}} -->`,
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("marks reviewer as STALE when evaluated commit differs from head SHA", () => {
    const olderSha = "a895efe284efc2ebf1ef2894c9a093af929cd98f";
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 102,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${olderSha}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->`,
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("STALE");
    expect(result.isFresh).toBe(false);
    expect(result.evaluatedCommitSha).toBe(olderSha);
    expect(result.verdict).toBe("NONE");
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("normalizes inline P0-P3 findings and reports CHANGES_REQUESTED when unresolved findings exist", () => {
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 103,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->`,
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "codex_t0",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/db/pool.ts",
        line: 50,
        originalLine: 50,
        comments: [
          {
            id: "c0",
            authorLogin: "chatgpt-codex-connector[bot]",
            body: `<!-- codex-code-review-finding:v1 -->
**P0 Badge** Fatal memory corruption risk.`,
            bodyDigest: "d0",
            path: "src/db/pool.ts",
            line: 50,
            originalLine: 50,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "codex_t1",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/db/pool.ts",
        line: 88,
        originalLine: 88,
        comments: [
          {
            id: "c1",
            authorLogin: "chatgpt-codex-connector[bot]",
            body: `<!-- codex-code-review-finding:v1 -->
**P1 Badge** Potential connection leak on unhandled rejection.`,
            bodyDigest: "d1",
            path: "src/db/pool.ts",
            line: 88,
            originalLine: 88,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "codex_t2",
        isResolved: true,
        resolvedByLogin: "gordonpn",
        isOutdated: false,
        path: "src/db/pool.ts",
        line: 120,
        originalLine: 120,
        comments: [
          {
            id: "c2",
            authorLogin: "chatgpt-codex-connector[bot]",
            body: `<!-- codex-code-review-finding:v1 -->
**P3 Badge** Consider adding debug log.`,
            bodyDigest: "d2",
            path: "src/db/pool.ts",
            line: 120,
            originalLine: 120,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads,
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings).toHaveLength(3);

    const [f0, f1, f2] = result.findings;
    expect(f0?.severity).toBe("BLOCKER");
    expect(f0?.isBlocking).toBe(true);

    expect(f1?.severity).toBe("HIGH");
    expect(f1?.isBlocking).toBe(true);
    expect(f1?.isResolved).toBe(false);

    expect(f2?.severity).toBe("LOW");
    expect(f2?.isBlocking).toBe(false);
    expect(f2?.isResolved).toBe(true);

    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("returns APPROVE when review is completed and fresh with zero unresolved findings", () => {
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 104,
        authorLogin: "chatgpt-codex-connector[bot]",
        body: `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->`,
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings).toHaveLength(0);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("ignores state markers posted by untrusted authors", () => {
    const conversationComments: GitHubConversationComment[] = [
      {
        id: 999,
        authorLogin: "untrusted-contributor",
        body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"}} -->`,
        bodyDigest: "digest",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: null,
      },
    ];

    const result = normalizeCodexReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments,
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
    expect(result.isFresh).toBe(false);
  });
});
