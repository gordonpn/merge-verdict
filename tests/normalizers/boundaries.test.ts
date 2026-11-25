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
  copilotNormalizer,
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
  location: Pick<
    GitHubReviewThread,
    "path" | "line" | "originalLine" | "startLine" | "originalStartLine" | "isOutdated"
  >,
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
        startLine: location.startLine ?? null,
        line: location.line,
        originalStartLine: location.originalStartLine ?? null,
        originalLine: location.originalLine,
        commitSha: headSha,
        originalCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

const inlineAdapters = [
  { adapter: codeRabbitNormalizer, authorLogin: "coderabbitai[bot]" },
  { adapter: copilotNormalizer, authorLogin: "copilot-pull-request-reviewer[bot]" },
  { adapter: sourceryNormalizer, authorLogin: "sourcery-ai[bot]" },
  { adapter: codexNormalizer, authorLogin: "chatgpt-codex-connector[bot]" },
];

const locations: {
  readonly name: string;
  readonly path: string | null;
  readonly startLine?: number | null;
  readonly line: number | null;
  readonly originalStartLine?: number | null;
  readonly originalLine: number | null;
  readonly isOutdated: boolean;
  readonly expectedStartLine: number | undefined;
  readonly expectedLine: number | undefined;
}[] = [
  {
    name: "multiline finding's current start and ending lines instead of its original lines",
    path: "src/new-name.ts",
    startLine: 18,
    line: 25,
    originalStartLine: 10,
    originalLine: 20,
    isOutdated: false,
    expectedStartLine: 18,
    expectedLine: 25,
  },
  {
    name: "deleted-file multiline finding at its original start and end lines when current lines are absent",
    path: "src/deleted-file.ts",
    startLine: null,
    line: null,
    originalStartLine: 8,
    originalLine: 12,
    isOutdated: true,
    expectedStartLine: 8,
    expectedLine: 12,
  },
  {
    name: "original range without mixing stale current startLine when current line is null",
    path: "src/deleted-file.ts",
    startLine: 5,
    line: null,
    originalStartLine: 8,
    originalLine: 12,
    isOutdated: true,
    expectedStartLine: 8,
    expectedLine: 12,
  },
  {
    name: "original line without mixing stale current startLine when originalStartLine is null",
    path: "src/deleted-file.ts",
    startLine: 5,
    line: null,
    originalStartLine: null,
    originalLine: 12,
    isOutdated: true,
    expectedStartLine: undefined,
    expectedLine: 12,
  },
  {
    name: "current line without mixing originalStartLine when current startLine is null",
    path: "src/current-file.ts",
    startLine: null,
    line: 25,
    originalStartLine: 10,
    originalLine: 20,
    isOutdated: false,
    expectedStartLine: undefined,
    expectedLine: 25,
  },
  {
    name: "single-line current finding without startLineNumber when startLine equals line",
    path: "src/single-line.ts",
    startLine: 25,
    line: 25,
    originalStartLine: 10,
    originalLine: 20,
    isOutdated: false,
    expectedStartLine: undefined,
    expectedLine: 25,
  },
  {
    name: "single-line original finding without startLineNumber when originalStartLine equals originalLine",
    path: "src/single-line-outdated.ts",
    startLine: null,
    line: null,
    originalStartLine: 12,
    originalLine: 12,
    isOutdated: true,
    expectedStartLine: undefined,
    expectedLine: 12,
  },
  {
    name: "current finding without startLineNumber when startLine is inverted above line",
    path: "src/inverted-current.ts",
    startLine: 30,
    line: 25,
    originalStartLine: 10,
    originalLine: 20,
    isOutdated: false,
    expectedStartLine: undefined,
    expectedLine: 25,
  },
  {
    name: "original finding without startLineNumber when originalStartLine is inverted above originalLine",
    path: "src/inverted-original.ts",
    startLine: null,
    line: null,
    originalStartLine: 18,
    originalLine: 12,
    isOutdated: true,
    expectedStartLine: undefined,
    expectedLine: 12,
  },
  {
    name: "current finding without startLineNumber when startLine is non-positive",
    path: "src/non-positive-start.ts",
    startLine: 0,
    line: 25,
    originalStartLine: null,
    originalLine: 20,
    isOutdated: false,
    expectedStartLine: undefined,
    expectedLine: 25,
  },
  {
    name: "file-level finding without fabricating a line number",
    path: "src/file-level.ts",
    startLine: null,
    line: null,
    originalStartLine: null,
    originalLine: null,
    isOutdated: false,
    expectedStartLine: undefined,
    expectedLine: undefined,
  },
  {
    name: "general finding without fabricating a path or line number",
    path: null,
    startLine: null,
    line: null,
    originalStartLine: null,
    originalLine: null,
    isOutdated: false,
    expectedStartLine: undefined,
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
      expect(finding.startLineNumber).toBe(location.expectedStartLine);
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

describe("Copilot rawCommentUrl with multiline ranges", () => {
  it("keeps rawCommentUrl anchored to comment line/originalLine without changing URL format", () => {
    const currentThread = makeThread("copilot-pull-request-reviewer[bot]", {
      path: "src/current.ts",
      startLine: 18,
      line: 25,
      originalStartLine: 10,
      originalLine: 20,
      isOutdated: false,
    });
    const outdatedThread = makeThread("copilot-pull-request-reviewer[bot]", {
      path: "src/deleted.ts",
      startLine: null,
      line: null,
      originalStartLine: 8,
      originalLine: 12,
      isOutdated: true,
    });

    const result = copilotNormalizer.normalize({
      headSha,
      repository: "octocat/hello-world",
      reviewThreads: [currentThread, outdatedThread],
      reviews: [makeReview("copilot-pull-request-reviewer[bot]", "Review completed.")],
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.startLineNumber).toBe(18);
    expect(result.findings[0]?.lineNumber).toBe(25);
    expect(result.findings[0]?.rawCommentUrl).toBe(
      `https://github.com/octocat/hello-world/blob/${headSha}/src/current.ts#L25`,
    );
    expect(result.findings[1]?.startLineNumber).toBe(8);
    expect(result.findings[1]?.lineNumber).toBe(12);
    expect(result.findings[1]?.rawCommentUrl).toBe(
      "https://github.com/octocat/hello-world/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/deleted.ts#L12",
    );
  });
});

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
