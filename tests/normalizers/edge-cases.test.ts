import { describe, expect, it } from "vitest";
import type {
  GitHubConversationComment,
  GitHubReviewSubmission,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { normalizeCodeRabbitReviewer } from "../../src/normalizers/coderabbit.js";
import { normalizeCodexReviewer } from "../../src/normalizers/codex.js";
import { normalizeDeepSeekReviewer } from "../../src/normalizers/deepseek.js";
import { normalizeSourceryReviewer } from "../../src/normalizers/sourcery.js";
import { stripMarkdownPunctuation } from "../../src/normalizers/utils.js";

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
function thread(
  authorLogin: string,
  body: string,
  path: string | null = "src/a.ts",
): GitHubReviewThread {
  return {
    id: "thread",
    isResolved: false,
    resolvedByLogin: null,
    isOutdated: false,
    path,
    line: 4,
    originalLine: 4,
    comments: [
      {
        id: "comment",
        authorLogin,
        body,
        bodyDigest: "digest",
        path,
        line: 4,
        originalLine: 4,
        commitSha: headSha,
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:00:00Z",
      },
    ],
  };
}
function comment(body: string): GitHubConversationComment {
  return {
    id: 1,
    authorLogin: "chatgpt-codex-connector[bot]",
    body,
    bodyDigest: "digest",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: null,
  };
}

describe("normalizer input edge cases", () => {
  it("ignores metadata and summary-only CodeRabbit review bodies", () => {
    const result = normalizeCodeRabbitReviewer({
      headSha,
      reviews: [
        review("coderabbitai", "# Summary\nNothing actionable"),
        review("coderabbitai", "# Nitpicks\nTypo\n# Review info\nMetadata"),
      ],
    });
    expect(result.findings.map((f) => f.title)).toEqual(["Typo"]);
    expect(result.verdict).toBe("APPROVE");
  });
  it.each(["<!-- hidden -->\n# Heading\n> quotation\n***", ""])(
    "uses CodeRabbit location fallback for hidden or empty titles %j",
    (body) => {
      const result = normalizeCodeRabbitReviewer({
        headSha,
        reviewThreads: [thread("coderabbitai", body)],
      });
      expect(result.findings[0]?.title).toBe("CodeRabbit finding on src/a.ts:4");
      expect(result.findings[0]?.isBlocking).toBe(true);
    },
  );
  it("ignores obsolete and empty CodeRabbit rate-limit comments after a completed check", () => {
    const result = normalizeCodeRabbitReviewer({
      headSha,
      checkRuns: [
        {
          id: 1,
          name: "CodeRabbit",
          status: "completed",
          conclusion: "failure",
          commitSha: headSha,
          detailsUrl: null,
          output: { title: null, summary: null, text: null },
          startedAt: null,
          completedAt: "2026-10-02T10:00:00Z",
        },
      ],
      conversationComments: [
        {
          ...comment("Review limit reached"),
          authorLogin: "coderabbitai",
          updatedAt: "2026-10-01T10:00:00Z",
        },
        { ...comment(""), authorLogin: "coderabbitai" },
      ],
    });
    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });
  it.each(["", "codex-review-state:v1", 'codex-review-state:v1 {"code_review":{}'])(
    "does not complete Codex from incomplete marker %j",
    (body) => {
      const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });
      expect(result.status).toBe("PENDING");
      expect(result.evaluatedCommitSha).toBeNull();
    },
  );
  it("keeps hidden Codex P2 findings blocking with a location fallback", () => {
    const result = normalizeCodexReviewer({
      headSha,
      reviewThreads: [thread("chatgpt-codex-connector", "<!-- P2 Badge -->\n> hidden quote\n***")],
    });
    expect(result.findings[0]).toMatchObject({
      title: "Codex finding on src/a.ts:4",
      severity: "MEDIUM",
      isBlocking: true,
    });
  });
  it("does not invent a DeepSeek verdict for a headingless trusted review", () => {
    const result = normalizeDeepSeekReviewer({
      headSha,
      reviews: [review("github-actions", "Review has no verdict heading")],
    });
    expect(result.verdict).toBe("NONE");
    expect(result.findings).toEqual([]);
  });
  it("parses numbered DeepSeek findings while ignoring prose and none placeholders", () => {
    const result = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        review(
          "github-actions",
          "## Verdict: REQUEST CHANGES\n### Material Findings 1. Fix the unsafe default\nExplanation only\n- None.\n12. Validate the input\n### Other section\n- Must not leak",
        ),
      ],
    });
    expect(result.findings.map((f) => f.title)).toEqual([
      "Fix the unsafe default",
      "Validate the input",
    ]);
    expect(result.findings.every((f) => f.isBlocking && f.severity === "HIGH")).toBe(true);
  });
  it.each(["<!-- hidden -->\n# Heading\n> quote\n***", ""])(
    "uses Sourcery fallback titles without visible body %j",
    (body) => {
      const result = normalizeSourceryReviewer({
        headSha,
        reviewThreads: [thread("sourcery-ai", body, null)],
      });
      expect(result.findings[0]).toMatchObject({
        title: "Sourcery finding",
        isBlocking: true,
        isResolved: false,
      });
    },
  );
  it("trims trailing Markdown punctuation without altering the title text", () => {
    expect(stripMarkdownPunctuation(" **Title with internal * emphasis** \t")).toBe(
      "Title with internal * emphasis",
    );
  });
});
