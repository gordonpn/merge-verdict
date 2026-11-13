import { describe, expect, it } from "vitest";
import type {
  GitHubReviewSubmission,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { normalizeCodeRabbitReviewer } from "../../src/normalizers/coderabbit.js";
import { normalizeCopilotReviewer } from "../../src/normalizers/copilot.js";
import { normalizeDeepSeekReviewer } from "../../src/normalizers/deepseek.js";

const headSha = "a".repeat(40);
function review(reviewerLogin: string, body: string): GitHubReviewSubmission {
  return {
    id: 1,
    reviewerLogin,
    body,
    state: "COMMENTED",
    commitSha: headSha,
    submittedAt: "2026-10-01T10:00:00Z",
    bodyDigest: "digest",
  };
}

describe("review parser regressions", () => {
  it.each([undefined, "success", "failure"] as const)(
    "keeps pending CodeRabbit reviews incomplete with check conclusion %s",
    (conclusion) => {
      const pendingReview = {
        ...review("coderabbitai[bot]", "Review in progress"),
        state: "PENDING" as const,
      };
      const result = normalizeCodeRabbitReviewer({
        headSha,
        reviews: [review("coderabbitai[bot]", "Earlier completed review"), pendingReview],
        checkRuns: conclusion
          ? [
              {
                id: 1,
                name: "CodeRabbit",
                status: "completed",
                conclusion,
                commitSha: headSha,
                detailsUrl: null,
                output: { title: null, summary: null, text: null },
                startedAt: null,
                completedAt: null,
              },
            ]
          : [],
      });
      expect(result.status).toBe(conclusion === "failure" ? "FAILED" : "PENDING");
      expect(result.verdict).toBe(conclusion === "failure" ? "CHANGES_REQUESTED" : "NONE");
      expect(result.isFresh).toBe(true);
    },
  );

  it.each([
    "NOT APPROVED",
    "DISAPPROVE",
    "NOT APPROVED (approval withheld)",
    "DISAPPROVE (do not approve)",
    "UNSUPPORTED (approve later)",
  ])("does not infer DeepSeek approval from unsupported verdict %s", (verdict) => {
    const result = normalizeDeepSeekReviewer({
      headSha,
      reviews: [review("github-actions[bot]", `## Verdict: ${verdict}`)],
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("COMMENTED");
    expect(result.findings).toEqual([]);
  });

  it.each([
    "APPROVE (no blocking issues)",
    "**APPROVE** (all checks passed)",
    "__APPROVE WITH MINOR FINDINGS__ (style only)",
  ])("retains affirmative DeepSeek verdict with explanation %s", (verdict) => {
    const result = normalizeDeepSeekReviewer({
      headSha,
      reviews: [review("github-actions[bot]", `## Verdict: ${verdict}`)],
    });
    expect(result.verdict).toBe("APPROVE");
  });

  it("ends outside-diff findings at its own closing details inside a wrapper", () => {
    const result = normalizeCodeRabbitReviewer({
      headSha,
      reviews: [
        review(
          "coderabbitai[bot]",
          `<details>
<summary>Review wrapper</summary>
<details>
<summary>Actionable comments outside diff</summary>
- Missing validation
</details>
<details>
<summary>Unrelated metadata</summary>
- ordinary metadata
</details>
</details>`,
        ),
      ],
    });
    expect(result.findings.map((finding) => finding.title)).toEqual(["Missing validation"]);
  });

  it.each(["__REQUEST CHANGES__", "__BLOCK__ (do not approve)"])(
    "recognizes emphasized blocking verdict %s",
    (verdict) => {
      const result = normalizeDeepSeekReviewer({
        headSha,
        reviews: [review("github-actions[bot]", `## Verdict: ${verdict}`)],
      });
      expect(result.status).toBe("COMPLETED");
      expect(result.verdict).toBe("CHANGES_REQUESTED");
    },
  );

  it("omits original-line anchors when only the comment commit is known", () => {
    const thread: GitHubReviewThread = {
      id: "thread",
      isResolved: false,
      resolvedByLogin: null,
      isOutdated: true,
      path: "src/example.ts",
      line: null,
      originalLine: 17,
      comments: [
        {
          id: "comment",
          authorLogin: "copilot-pull-request-reviewer[bot]",
          body: "Fix this",
          bodyDigest: "digest",
          path: "src/example.ts",
          line: null,
          originalLine: 17,
          commitSha: headSha,
          createdAt: "2026-10-01T10:00:00Z",
          updatedAt: "2026-10-01T10:00:00Z",
        },
      ],
    };
    const result = normalizeCopilotReviewer({
      headSha,
      repository: "owner/repo",
      reviewThreads: [thread],
    });
    expect(result.findings[0]?.rawCommentUrl).toBe(
      `https://github.com/owner/repo/blob/${headSha}/src/example.ts`,
    );
    expect(result.findings[0]?.lineNumber).toBe(17);
  });
});
