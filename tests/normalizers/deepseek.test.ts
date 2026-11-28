import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  GitHubCheckRun,
  GitHubReviewSubmission,
} from "../../src/collector/github-collector.js";
import { createDefaultConfig } from "../../src/models/config.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { createReviewSnapshot } from "../../src/models/snapshot.js";
import { deepSeekNormalizer, normalizeDeepSeekReviewer } from "../../src/normalizers/deepseek.js";
import { evaluatePolicy } from "../../src/policy/evaluator.js";

describe("normalizeDeepSeekReviewer", () => {
  const headSha = "6ad1952e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c";

  function makeSubsectionReview(verdict: string, boundary: string): GitHubReviewSubmission {
    const body = readFileSync(
      new URL("../fixtures/deepseek/subsection-findings.md", import.meta.url),
      "utf8",
    )
      .replace("{{verdict}}", verdict)
      .replace("{{boundary}}", boundary);
    return {
      id: 600,
      reviewerLogin: "github-actions[bot]",
      state: "COMMENTED",
      commitSha: headSha,
      submittedAt: "2026-11-22T04:00:00Z",
      body,
      bodyDigest: "subsections",
    };
  }

  it.each([
    [
      "APPROVE",
      [
        ["MEDIUM", false, true],
        ["LOW", false, true],
      ],
    ],
    [
      "APPROVE WITH MINOR FINDINGS",
      [
        ["MEDIUM", false, true],
        ["LOW", false, true],
      ],
    ],
    [
      "REQUEST CHANGES",
      [
        ["MEDIUM", true, false],
        ["LOW", false, false],
      ],
    ],
    [
      "BLOCK",
      [
        ["MEDIUM", true, false],
        ["LOW", false, false],
      ],
    ],
  ] as const)(
    "preserves %s severity and blocking rules for explicitly labeled subsection findings",
    (verdict, expected) => {
      const review = makeSubsectionReview(verdict, "## Missing Verification");

      const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

      expect(result.findings.map((f) => [f.severity, f.isBlocking, f.isResolved])).toEqual(
        expected,
      );
      expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
    },
  );

  it.each([
    ["APPROVE", "MEDIUM", false],
    ["APPROVE WITH MINOR FINDINGS", "LOW", false],
    ["REQUEST CHANGES", "HIGH", true],
    ["BLOCK", "BLOCKER", true],
  ] as const)(
    "falls back to %s verdict defaults for unlabeled subsection and bullet findings",
    (verdict, severity, blocking) => {
      const subsectionReview: GitHubReviewSubmission = {
        ...makeSubsectionReview(verdict, "## Missing Verification"),
        body: [
          `## Verdict: ${verdict}`,
          "",
          "## Material Findings",
          "",
          "### 1. Missing boundary check",
          "Validate user input cleanly.",
          "### 2. Follow up on docs",
          "Document the edge case.",
        ].join("\n"),
        bodyDigest: `unlabeled-sub-${verdict}`,
      };
      const bulletReview: GitHubReviewSubmission = {
        ...makeSubsectionReview(verdict, "## Missing Verification"),
        body: [
          `## Verdict: ${verdict}`,
          "",
          "## Material Findings",
          "",
          "* Missing boundary check",
          "* Follow up on docs",
        ].join("\n"),
        bodyDigest: `unlabeled-bullet-${verdict}`,
      };

      for (const review of [subsectionReview, bulletReview]) {
        const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

        expect(result.findings.map((f) => [f.severity, f.isBlocking, f.isResolved])).toEqual([
          [severity, blocking, !blocking],
          [severity, blocking, !blocking],
        ]);
        expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
      }
    },
  );

  it("extracts explicit severities across delimiters and ignores unlabeled prose words", () => {
    const requestChangesBody = [
      "## Verdict: REQUEST CHANGES",
      "",
      "## Material Findings",
      "",
      "### 1. BLOCKER - Missing auth check",
      "Auth bypassed.",
      "### 2. CRITICAL: Secret logged",
      "Token written to stderr.",
      `### 3. HIGH \u2014 Unchecked integer overflow`,
      "Bounds skipped.",
      `### 4. [MEDIUM] \u2013 Missing pagination cap`,
      "Limit omitted.",
      "### 5. **LOW** - Rename internal helper",
      "Minor naming cleanup.",
      "### 6. ADVISORY: Document timeout default",
      "Add note.",
      "### 7. INFO - Confirmed safe fallback",
      "Informational only.",
      "### 8. Low-level socket leak left unguarded",
      "Cleanup omitted on error path.",
      "### 9. High latency under load when retrying",
      "Retry backoff grows unbounded.",
      "### 10. Info disclosure check skipped in mock",
      "Mock helper omits sanitization.",
      "### 11. HIGH severity bug without delimiter",
      "No delimiter after severity token.",
    ].join("\n");

    const requestChanges = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          ...makeSubsectionReview("REQUEST CHANGES", "## Missing Verification"),
          body: requestChangesBody,
          bodyDigest: "explicit-severities-rc",
        },
      ],
    });

    expect(requestChanges.findings.map((f) => [f.severity, f.isBlocking, f.isResolved])).toEqual([
      ["BLOCKER", true, false],
      ["BLOCKER", true, false],
      ["HIGH", true, false],
      ["MEDIUM", true, false],
      ["LOW", false, false],
      ["ADVISORY", false, false],
      ["ADVISORY", false, false],
      ["HIGH", true, false],
      ["HIGH", true, false],
      ["HIGH", true, false],
      ["HIGH", true, false],
    ]);

    const blockReview = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          ...makeSubsectionReview("BLOCK", "## Missing Verification"),
          body: [
            "## Verdict: BLOCK",
            "",
            "## Material Findings",
            "",
            "* High latency under load when retrying",
            "* Info disclosure check skipped in mock",
          ].join("\n"),
          bodyDigest: "explicit-severities-block",
        },
      ],
    });

    expect(blockReview.findings.map((f) => [f.severity, f.isBlocking, f.isResolved])).toEqual([
      ["BLOCKER", true, false],
      ["BLOCKER", true, false],
    ]);

    const minorApproval = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          ...makeSubsectionReview("APPROVE WITH MINOR FINDINGS", "## Missing Verification"),
          body: [
            "## Verdict: APPROVE WITH MINOR FINDINGS",
            "",
            "## Material Findings",
            "",
            "* High latency under load when retrying",
            "* Info disclosure check skipped in mock",
            "* MEDIUM - Non-blocking minor refactor",
          ].join("\n"),
          bodyDigest: "explicit-severities-minor",
        },
      ],
    });

    expect(minorApproval.findings.map((f) => [f.severity, f.isBlocking, f.isResolved])).toEqual([
      ["LOW", false, true],
      ["LOW", false, true],
      ["MEDIUM", false, true],
    ]);
  });

  it.each([" ", "\u00a0", "\u3000"])("handles long %j prefixes and Unicode titles", (spacing) => {
    const body = readFileSync(
      new URL("../fixtures/deepseek/whitespace-heading.md", import.meta.url),
      "utf8",
    ).replace("{{spacing}}", spacing.repeat(30_000));
    const review = {
      ...makeSubsectionReview("REQUEST CHANGES", "## Missing Verification"),
      body,
    };

    const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

    expect(result.findings.map((finding) => finding.title)).toEqual([
      "Retain the finding\u2028and its detail",
    ]);
  });

  it.each(["## Unverified Assumptions", "### Unverified Assumptions", "### Missing Verification"])(
    "extracts subsection findings and stops at %s",
    (boundary) => {
      const review = makeSubsectionReview("REQUEST CHANGES", boundary);

      const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

      expect(result.findings.map((f) => f.title)).toEqual([
        "MEDIUM - Missing boundary guard",
        "LOW - Clarify the diagnostic",
      ]);
      expect(result.findings.map((f) => f.description)).toEqual([
        "MEDIUM - Missing boundary guard\nThe input crosses a trust boundary without validation.\n#### Verification detail\n- Reject malformed input.\n- Preserve the error result.",
        "LOW - Clarify the diagnostic\nDescribe the rejected input without exposing its value.",
      ]);
      expect(result.findings.map((f) => [f.severity, f.isBlocking, f.isResolved])).toEqual([
        ["MEDIUM", true, false],
        ["LOW", false, false],
      ]);
    },
  );

  it("preserves fenced headings, indentation, and fenced dividers while stripping standalone dividers", () => {
    const body = readFileSync(
      new URL("../fixtures/deepseek/fenced-findings.md", import.meta.url),
      "utf8",
    );
    const review = {
      ...makeSubsectionReview("REQUEST CHANGES", "## Unverified Assumptions"),
      body,
      bodyDigest: "fenced-findings",
    };

    const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

    expect(result.findings.map((f) => f.title)).toEqual([
      "HIGH - Preserve fenced headings and indentation",
      "MEDIUM - Retain indented lines outside fences",
    ]);
    expect(result.findings.map((f) => f.description)).toEqual([
      [
        "HIGH - Preserve fenced headings and indentation",
        "Example showing headings and dividers inside a fenced block:",
        "```text",
        "## Example Section",
        "",
        "### 2. Not a real finding",
        "",
        "  if (ready) {",
        "    return true;",
        "  }",
        "---",
        "```",
      ].join("\n"),
      [
        "MEDIUM - Retain indented lines outside fences",
        "Keep the indented example:",
        "    const guarded = true;",
      ].join("\n"),
    ]);
  });

  it("tracks CommonMark tilde fences and ignores shorter closing fences and outside dividers", () => {
    const body = [
      "## Verdict: REQUEST CHANGES",
      "",
      "## Material Findings",
      "",
      "### 1. First finding with tilde fence",
      "~~~~markdown",
      "## Heading inside tilde fence",
      "~~~",
      "### 2. Not a second finding",
      "~~~~",
      "   * * *",
      "___",
      "### 2. Real second finding",
      "Detail after tilde fence.",
      "## Missing Verification",
      "Ignored trailing section.",
    ].join("\n");

    const review = {
      ...makeSubsectionReview("REQUEST CHANGES", "## Missing Verification"),
      body,
      bodyDigest: "tilde-fence",
    };

    const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

    expect(result.findings.map((f) => f.title)).toEqual([
      "First finding with tilde fence",
      "Real second finding",
    ]);
    expect(result.findings[0]?.description).toBe(
      [
        "First finding with tilde fence",
        "~~~~markdown",
        "## Heading inside tilde fence",
        "~~~",
        "### 2. Not a second finding",
        "~~~~",
      ].join("\n"),
    );
    expect(result.findings[1]?.description).toBe(
      ["Real second finding", "Detail after tilde fence."].join("\n"),
    );
  });

  it("keeps unclosed fenced blocks within the active finding until EOF", () => {
    const body = [
      "## Verdict: REQUEST CHANGES",
      "",
      "## Material Findings",
      "",
      "### 1. Finding with unclosed fence",
      "   ```ts",
      "## Unverified Assumptions",
      "### 2. Should stay inside fence",
      "    const nested = 1;",
      "---",
      "",
    ].join("\n");

    const review = {
      ...makeSubsectionReview("REQUEST CHANGES", "## Unverified Assumptions"),
      body,
      bodyDigest: "unclosed-fence",
    };

    const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Finding with unclosed fence");
    expect(result.findings[0]?.description).toBe(
      [
        "Finding with unclosed fence",
        "   ```ts",
        "## Unverified Assumptions",
        "### 2. Should stay inside fence",
        "    const nested = 1;",
        "---",
      ].join("\n"),
    );
  });

  it("does not treat inline backtick spans as fences and strips CR with CRLF input", () => {
    const body = [
      "## Verdict: REQUEST CHANGES",
      "",
      "## Material Findings",
      "",
      "### 1. Inline triple-backtick span",
      "```inline```",
      "  indented continuation",
      "### 2. Next finding after CRLF fence",
      "```ts",
      "  const ok = true;",
      "```",
    ].join("\r\n");

    const review = {
      ...makeSubsectionReview("REQUEST CHANGES", "## Unverified Assumptions"),
      body,
      bodyDigest: "inline-backtick-crlf",
    };

    const result = normalizeDeepSeekReviewer({ headSha, reviews: [review] });

    expect(result.findings.map((f) => f.title)).toEqual([
      "Inline triple-backtick span",
      "Next finding after CRLF fence",
    ]);
    expect(result.findings[0]?.description).toBe(
      ["Inline triple-backtick span", "```inline```", "  indented continuation"].join("\n"),
    );
    expect(result.findings[1]?.description).toBe(
      ["Next finding after CRLF fence", "```ts", "  const ok = true;", "```"].join("\n"),
    );
  });

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

    const singleLineNoColon = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 512,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:02:00Z",
          body: "## Verdict **BLOCK**\n\n### Material Findings\n* Critical finding.",
          bodyDigest: "d12",
        },
      ],
    });

    expect(singleLineNoColon.status).toBe("COMPLETED");
    expect(singleLineNoColon.verdict).toBe("CHANGES_REQUESTED");
    expect(singleLineNoColon.findings[0]?.severity).toBe("BLOCKER");

    const headingWithoutValue = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 509,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T09:59:00Z",
          body: "## Verdict: BLOCK\n\n### Material Findings\n* Existing blocker.",
          bodyDigest: "d09",
        },
        {
          id: 513,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:03:00Z",
          body: "## Verdict\n",
          bodyDigest: "d13",
        },
      ],
    });

    expect(headingWithoutValue.status).toBe("COMPLETED");
    expect(headingWithoutValue.verdict).toBe("CHANGES_REQUESTED");
    expect(headingWithoutValue.findings[0]?.severity).toBe("BLOCKER");

    const headingFollowedByProse = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 514,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:04:00Z",
          body: "## Verdict\n\nSee inline comments.",
          bodyDigest: "d14",
        },
      ],
    });

    expect(headingFollowedByProse.status).toBe("PENDING");
    expect(headingFollowedByProse.verdict).toBe("NONE");

    const unrelatedHeading = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 515,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:05:00Z",
          body: "## Verdict History\n\nPrevious note.",
          bodyDigest: "d15",
        },
      ],
    });

    expect(unrelatedHeading.status).toBe("PENDING");
    expect(unrelatedHeading.verdict).toBe("NONE");

    const prefixWordHeading = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 516,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:06:00Z",
          body: "## Verdict **BLOCKING ISSUES**\n\nGeneral commentary.",
          bodyDigest: "d16",
        },
      ],
    });

    expect(prefixWordHeading.status).toBe("PENDING");
    expect(prefixWordHeading.verdict).toBe("NONE");

    const proseAfterHeadingWithKeywords = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 517,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:07:00Z",
          body: "## Verdict\n\nPlease do not block this PR; see request changes notes below.",
          bodyDigest: "d17",
        },
      ],
    });

    expect(proseAfterHeadingWithKeywords.status).toBe("PENDING");
    expect(proseAfterHeadingWithKeywords.verdict).toBe("NONE");

    const underscoreEmphasisVerdicts = [
      { body: "## Verdict __BLOCK__", expectedVerdict: "CHANGES_REQUESTED" },
      { body: "## Verdict __REQUEST_CHANGES__", expectedVerdict: "CHANGES_REQUESTED" },
      { body: "## Verdict __APPROVE__", expectedVerdict: "APPROVE" },
    ] as const;

    for (const [offset, testCase] of underscoreEmphasisVerdicts.entries()) {
      const underscoreResult = normalizeDeepSeekReviewer({
        headSha,
        reviews: [
          {
            id: 520 + offset,
            reviewerLogin: "github-actions[bot]",
            state: "COMMENTED",
            commitSha: headSha,
            submittedAt: "2026-10-01T10:10:00Z",
            body: testCase.body,
            bodyDigest: `d20-${offset}`,
          },
        ],
      });

      expect(underscoreResult.status).toBe("COMPLETED");
      expect(underscoreResult.verdict).toBe(testCase.expectedVerdict);
    }

    const verdictHistoryBeforeVerdict = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 525,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:11:00Z",
          body: `## Verdict History

Previous note.

## Verdict: REQUEST CHANGES

### Material Findings
* Handle history headings.`,
          bodyDigest: "d25",
        },
      ],
    });

    expect(verdictHistoryBeforeVerdict.status).toBe("COMPLETED");
    expect(verdictHistoryBeforeVerdict.verdict).toBe("CHANGES_REQUESTED");
    expect(verdictHistoryBeforeVerdict.findings).toHaveLength(1);

    const colonHeadingFollowedBySubheading = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 526,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:12:00Z",
          body: "## Verdict:\n\n### BLOCK",
          bodyDigest: "d26",
        },
      ],
    });

    expect(colonHeadingFollowedBySubheading.status).toBe("COMPLETED");
    expect(colonHeadingFollowedBySubheading.verdict).toBe("COMMENTED");

    const singleLineRequestChanges = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 518,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:08:00Z",
          body: "## Verdict **REQUEST CHANGES**\r\n\r\n### Material Findings\r\n* Fix guard.",
          bodyDigest: "d18",
        },
      ],
    });

    expect(singleLineRequestChanges.status).toBe("COMPLETED");
    expect(singleLineRequestChanges.verdict).toBe("CHANGES_REQUESTED");

    const crlfMultilineBlock = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          id: 519,
          reviewerLogin: "github-actions[bot]",
          state: "COMMENTED",
          commitSha: headSha,
          submittedAt: "2026-10-01T10:09:00Z",
          body: "## Verdict:\r\n\r\n**BLOCK**\r\n\r\n### Material Findings\r\n* Unsafe boundary.",
          bodyDigest: "d19",
        },
      ],
    });

    expect(crlfMultilineBlock.status).toBe("COMPLETED");
    expect(crlfMultilineBlock.verdict).toBe("CHANGES_REQUESTED");
    expect(crlfMultilineBlock.findings[0]?.severity).toBe("BLOCKER");
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

  it("keeps LOW and ADVISORY findings open under REQUEST CHANGES for downstream policy thresholds", () => {
    const reviewer = normalizeDeepSeekReviewer({
      headSha,
      reviews: [
        {
          ...makeSubsectionReview("REQUEST CHANGES", "## Missing Verification"),
          body: [
            "## Verdict: REQUEST CHANGES",
            "",
            "## Material Findings",
            "",
            "* [LOW] Clarify error message wording",
            "* [ADVISORY] Consider documenting default timeout",
          ].join("\n"),
          bodyDigest: "policy-is-resolved-contract",
        },
      ],
    });

    const snapshot = createReviewSnapshot({
      repository: "owner/repo",
      pullRequestNumber: 189,
      headSha,
      baseSha: "base",
      isDraft: false,
      capturedAt: "2026-11-27T00:00:00Z",
      unresolvedThreadCount: 0,
      blockingDecisionCount: 0,
      checkRuns: {},
      reviewers: { "deepseek-review": reviewer },
    });
    const baseConfig = createDefaultConfig();
    const defaultConfig = {
      ...baseConfig,
      requiredReviewers: ["deepseek-review"],
      allowAdvisoryExemptions: true,
    };
    const finalSnapshot = { headSha, stateFingerprint: snapshot.stateFingerprint };

    const defaultEvaluation = evaluatePolicy({
      snapshot,
      config: defaultConfig,
      finalSnapshot,
      executionErrors: [],
      repositoryRules: [],
      codeEvidenceSatisfied: true,
    });
    const lowThresholdEvaluation = evaluatePolicy({
      snapshot,
      config: defaultConfig,
      finalSnapshot,
      executionErrors: [],
      repositoryRules: [],
      codeEvidenceSatisfied: true,
      blockingSeverityThreshold: "LOW",
    });
    const strictAdvisoryEvaluation = evaluatePolicy({
      snapshot,
      config: { ...defaultConfig, allowAdvisoryExemptions: false },
      finalSnapshot,
      executionErrors: [],
      repositoryRules: [],
      codeEvidenceSatisfied: true,
    });

    expect(defaultEvaluation.reasons.filter((r) => r.condition === 3)).toEqual([]);
    expect(defaultEvaluation.reasons.filter((r) => r.condition === 4)).toEqual([
      { condition: 4, outcome: "FAIL", code: "CHANGES_REQUESTED", subject: "deepseek-review" },
    ]);
    expect(lowThresholdEvaluation.reasons.filter((r) => r.condition === 3)).toEqual([
      { condition: 3, outcome: "FAIL", code: "UNRESOLVED_FINDING", subject: "deepseek_finding_1" },
    ]);
    expect(strictAdvisoryEvaluation.reasons.filter((r) => r.condition === 3)).toEqual([
      { condition: 3, outcome: "FAIL", code: "UNRESOLVED_FINDING", subject: "deepseek_finding_1" },
      { condition: 3, outcome: "FAIL", code: "UNRESOLVED_FINDING", subject: "deepseek_finding_2" },
    ]);
  });
});
