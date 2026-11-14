import { describe, expect, it } from "vitest";
import type {
  GitHubConversationComment,
  GitHubReviewSubmission,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { NormalizedFindingSchema } from "../../src/models/finding.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import {
  codeRabbitNormalizer,
  codexNormalizer,
  deepSeekNormalizer,
  sourceryNormalizer,
} from "../../src/normalizers/index.js";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const timestamp = "2026-10-01T10:00:00Z";
const markdown = [
  "Potential issue: keep the migration backwards compatible.",
  "",
  "| Before | After |",
  "| --- | --- |",
  "| oldName | newName |",
  "",
  "```ts",
  "const migration = { previous: 'oldName', current: 'newName' };",
  "```",
].join("\n");

function makeReview(reviewerLogin: string, body: string): GitHubReviewSubmission {
  return {
    id: 1,
    reviewerLogin,
    state: "COMMENTED",
    commitSha: headSha,
    submittedAt: timestamp,
    body,
    bodyDigest: "review-digest",
  };
}

function makeConversation(authorLogin: string, body: string): GitHubConversationComment {
  return {
    id: 2,
    authorLogin,
    body,
    bodyDigest: "conversation-digest",
    createdAt: timestamp,
    updatedAt: null,
  };
}

function makeThread(
  authorLogin: string,
  location: Pick<GitHubReviewThread, "path" | "line" | "originalLine" | "isOutdated">,
): GitHubReviewThread {
  return {
    id: "boundary-thread",
    isResolved: false,
    resolvedByLogin: null,
    ...location,
    comments: [
      {
        id: "boundary-comment",
        authorLogin,
        body: markdown,
        bodyDigest: "comment-digest",
        path: location.path,
        line: location.line,
        originalLine: location.originalLine,
        commitSha: headSha,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

const inlineAdapters = [
  { adapter: codeRabbitNormalizer, authorLogin: "coderabbitai[bot]" },
  { adapter: sourceryNormalizer, authorLogin: "sourcery-ai[bot]" },
  { adapter: codexNormalizer, authorLogin: "chatgpt-codex-connector[bot]" },
];

const locations = [
  {
    name: "multiline finding's current ending line instead of its original line",
    path: "src/new-name.ts",
    line: 25,
    originalLine: 20,
    isOutdated: false,
    expectedLine: 25,
  },
  {
    name: "deleted-file finding at its original line when the current line is absent",
    path: "src/deleted-file.ts",
    line: null,
    originalLine: 12,
    isOutdated: true,
    expectedLine: 12,
  },
  {
    name: "file-level finding without fabricating a line number",
    path: "src/file-level.ts",
    line: null,
    originalLine: null,
    isOutdated: false,
    expectedLine: undefined,
  },
  {
    name: "general finding without fabricating a path or line number",
    path: null,
    line: null,
    originalLine: null,
    isOutdated: false,
    expectedLine: undefined,
  },
];

describe.each(inlineAdapters)(
  "$adapter.reviewerName finding boundaries",
  ({ adapter, authorLogin }) => {
    it.each(locations)("preserves $name", (location) => {
      const thread = makeThread(authorLogin, location);
      const input = {
        headSha,
        reviewThreads: [thread],
        reviews: [makeReview(authorLogin, "Review completed.")],
        conversationComments: [
          makeConversation(
            "chatgpt-codex-connector[bot]",
            `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${headSha}","status":"completed"}} -->`,
          ),
        ],
      };

      const result = adapter.normalize(input);

      expect(result.status).toBe("COMPLETED");
      expect(result.findings).toHaveLength(1);
      const finding = NormalizedFindingSchema.parse(result.findings[0]);
      expect(finding.threadId).toBe(thread.id);
      expect(finding.filePath).toBe(location.path ?? undefined);
      expect(finding.lineNumber).toBe(location.expectedLine);
      expect(finding.description).toBe(markdown);
      expect(finding.isResolved).toBe(false);
      expect(finding.isBlocking).toBe(true);
      expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
      expect(adapter.normalize(input)).toEqual(result);
    });

    it("does not mistake unstructured top-level Markdown commentary for inline findings", () => {
      const result = adapter.normalize({
        headSha,
        conversationComments: [makeConversation(authorLogin, markdown)],
      });

      expect(result.findings).toEqual([]);
      expect(result.status).toBe("PENDING");
      expect(result.verdict).toBe("NONE");
      expect(result.isFresh).toBe(false);
      expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
    });
  },
);

describe("non-file review findings", () => {
  it("preserves a CodeRabbit outside-diff finding without a source location", () => {
    const result = codeRabbitNormalizer.normalize({
      headSha,
      reviews: [
        makeReview(
          "coderabbitai[bot]",
          `${markdown}\n\n<details>\n<summary>Actionable comments outside diff</summary>\n- Potential issue: migration drops historical records.\n</details>`,
        ),
      ],
    });

    expect(result.findings).toHaveLength(1);
    const finding = NormalizedFindingSchema.parse(result.findings[0]);
    expect(finding.description).toBe("Potential issue: migration drops historical records.");
    expect(finding.filePath).toBeUndefined();
    expect(finding.lineNumber).toBeUndefined();
    expect(finding.threadId).toBeUndefined();
    expect(finding.isBlocking).toBe(true);
  });

  it("extracts DeepSeek material findings alongside Markdown without invented file positions", () => {
    const result = deepSeekNormalizer.normalize({
      headSha,
      reviews: [
        makeReview(
          "github-actions[bot]",
          `## Verdict: REQUEST CHANGES\n\n${markdown}\n\n### Material Findings\n- Migration drops historical records.\n\n### Verification\n- Example outside the findings section.`,
        ),
      ],
      conversationComments: [makeConversation("github-actions[bot]", markdown)],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings).toHaveLength(1);
    const finding = NormalizedFindingSchema.parse(result.findings[0]);
    expect(finding.description).toBe("Migration drops historical records.");
    expect(finding.filePath).toBeUndefined();
    expect(finding.lineNumber).toBeUndefined();
    expect(finding.threadId).toBeUndefined();
    expect(finding.isBlocking).toBe(true);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("does not infer a commit-bound DeepSeek verdict from an ordinary conversation comment", () => {
    const result = deepSeekNormalizer.normalize({
      headSha,
      conversationComments: [
        makeConversation(
          "github-actions[bot]",
          `## Verdict: APPROVE\n\n${markdown}\n\n### Material Findings\nNone.`,
        ),
      ],
    });

    expect(result.findings).toEqual([]);
    expect(result.status).toBe("PENDING");
    expect(result.isFresh).toBe(false);
    expect(result.verdict).toBe("NONE");
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });
});
