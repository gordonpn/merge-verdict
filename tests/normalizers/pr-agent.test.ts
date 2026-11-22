import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  GitHubCheckRun,
  GitHubConversationComment,
  GitHubPullRequestData,
} from "../../src/collector/github-collector.js";
import { CHECK_RUN_CONCLUSIONS } from "../../src/models/check-run.js";
import { createDefaultConfig } from "../../src/models/config.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { buildReviewSnapshotFromPullRequest } from "../../src/normalizers/index.js";
import { normalizePrAgentReviewer, prAgentNormalizer } from "../../src/normalizers/pr-agent.js";
import { evaluatePolicy } from "../../src/policy/evaluator.js";

const headSha = "f938eb23b9b6d7c9d48f9c439b02b36803f989a3";
function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/pr-agent/${name}`, import.meta.url), "utf8");
}
function comment(
  body: string,
  overrides: Partial<GitHubConversationComment> = {},
): GitHubConversationComment {
  return {
    id: 1,
    authorLogin: "github-actions[bot]",
    body,
    bodyDigest: "digest",
    createdAt: "2026-11-19T10:00:00Z",
    updatedAt: null,
    ...overrides,
  };
}
function check(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 1,
    name: "runner / pr-agent",
    status: "completed",
    conclusion: "success",
    commitSha: headSha,
    detailsUrl: null,
    output: { title: null, summary: null, text: null },
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}
const StateFixtureSchema = z.object({
  schema_version: z.number(),
  last_run: z.object({ head_sha: z.string(), complete: z.boolean(), kind: z.string() }),
  findings: z.array(
    z.object({
      finding_id: z.string(),
      body: z.string(),
      state: z.string(),
      path: z.string(),
      line_start: z.number(),
    }),
  ),
});
function stateComment(complete = true, findingState = "ACTIVE"): string {
  const state = StateFixtureSchema.parse(JSON.parse(fixture("state.json")));
  return fixture("state-comment.md").replace(
    "{{state}}",
    JSON.stringify({
      ...state,
      last_run: { ...state.last_run, head_sha: headSha, complete },
      findings: state.findings.map((f) => ({ ...f, state: findingState })),
    }),
  );
}

describe("PR-Agent normalization", () => {
  it("retains link-prefixed and following non-compliance bullets", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [
        comment(`${stateComment(true, "RESOLVED")}
Ticket compliance analysis
Non-compliant requirements:
- [src/file.ts](https://example.com) misses a requirement
- Another missing requirement`),
      ],
    });
    expect(result.findings.filter((finding) => finding.isBlocking)).toHaveLength(2);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });
  it.each(["stale", "unknown", ""])(
    "fails closed on unsupported completed conclusion %s",
    (conclusion) => {
      const result = normalizePrAgentReviewer({
        headSha,
        conversationComments: [comment(stateComment(true, "RESOLVED"))],
        checkRuns: [check({ conclusion })],
      });
      expect(result.status).toBe("FAILED");
      expect(result.verdict).not.toBe("APPROVE");
    },
  );
  it("keeps explicit stale review provenance despite a successful current check", () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(stateComment().replace(headSha, oldSha))],
      checkRuns: [check()],
    });
    expect(result).toMatchObject({
      status: "STALE",
      evaluatedCommitSha: oldSha,
      isFresh: false,
      findings: [],
    });
  });
  it("does not parse state finding text as a ticket section", () => {
    const body =
      stateComment().replace("Unresolved concern", "Ticket compliance analysis") +
      "\nNon-compliant requirements:\n- Outside any ticket section";
    const result = normalizePrAgentReviewer({ headSha, conversationComments: [comment(body)] });
    expect(result.findings).toHaveLength(1);
  });
  it("keeps unknown review provenance pending after successful workflow completion", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(fixture("pr-133.md"))],
      checkRuns: [check()],
    });
    expect(result).toMatchObject({
      status: "PENDING",
      evaluatedCommitSha: null,
      isFresh: false,
      verdict: "CHANGES_REQUESTED",
    });
  });
  it("ignores an older check when the review itself proves the current head", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(stateComment(true, "RESOLVED"))],
      checkRuns: [
        check({ commitSha: "1111111111111111111111111111111111111111", conclusion: "failure" }),
      ],
    });
    expect(result).toMatchObject({
      status: "COMPLETED",
      evaluatedCommitSha: headSha,
      isFresh: true,
      verdict: "APPROVE",
    });
  });
  it("does not recover approval from a malformed state via a valid Markdown header", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      repository: "fixture-owner/merge-verdict",
      conversationComments: [
        comment(`${fixture("pr-134.md")}\n<!-- pr-agent-review-state:v1 {broken -->`),
      ],
    });
    expect(result).toMatchObject({ status: "PENDING", evaluatedCommitSha: null, isFresh: false });
  });
  it("captures live ticket non-compliance with explicit repository-bound SHA", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      repository: "fixture-owner/merge-verdict",
      conversationComments: [comment(fixture("pr-134.md"))],
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      isFresh: true,
      evaluatedCommitSha: headSha,
      verdict: "CHANGES_REQUESTED",
    });
    expect(result.findings.map((f) => f.description)).toEqual([
      "All acceptance criteria remain unfulfilled by this PR; it is a documentation refresh only",
      "No verification test or script check added",
      "No normalizer change or regression coverage added",
    ]);
    expect(
      result.findings.every((f) => f.severity === "HIGH" && f.isBlocking && !f.isResolved),
    ).toBe(true);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });
  it("retains concerns when captured comment has no SHA even with a newer timestamp", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(fixture("pr-133.md"), { updatedAt: "2030-01-01T00:00:00Z" })],
    });

    expect(result).toMatchObject({
      status: "PENDING",
      evaluatedCommitSha: null,
      isFresh: false,
      verdict: "CHANGES_REQUESTED",
    });
    expect(result.findings.map((f) => f.description)).toEqual([
      "Set required_reviewers to [deepseek-review] in .github/merge-verdict.yml (not part of this PR's diff; may have been done in a prior PR).",
    ]);
  });
  it.each(["other/repo", undefined])(
    "rejects header provenance from unmatched repository %s",
    (repository) => {
      const result = normalizePrAgentReviewer({
        headSha,
        ...(repository ? { repository } : {}),
        conversationComments: [comment(fixture("pr-134.md"))],
      });

      expect(result.status).toBe("PENDING");
      expect(result.evaluatedCommitSha).toBeNull();
    },
  );
  it("marks an explicit older SHA stale without carrying superseded findings forward", () => {
    const result = normalizePrAgentReviewer({
      headSha: "new-head",
      repository: "fixture-owner/merge-verdict",
      conversationComments: [comment(fixture("pr-134.md"))],
    });

    expect(result).toMatchObject({
      status: "STALE",
      isFresh: false,
      evaluatedCommitSha: headSha,
      verdict: "NONE",
      findings: [],
    });
  });
  it.each([true, false])("respects complete=%s in captured state format", (complete) => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(stateComment(complete))],
    });

    expect(result.status).toBe(complete ? "COMPLETED" : "PENDING");
    expect(result.isFresh).toBe(true);
    expect(result.findings[0]).toMatchObject({
      id: "pr-agent-finding-1",
      description: "Unresolved concern",
      filePath: "src/file.ts",
      lineNumber: 4,
      isResolved: false,
    });
  });
  it.each(["RESOLVED", "FIXED", "ACTIVE", "UNKNOWN"])(
    "handles finding state %s conservatively",
    (state) => {
      const result = normalizePrAgentReviewer({
        headSha,
        conversationComments: [comment(stateComment(true, state))],
      });

      const resolved = state === "RESOLVED" || state === "FIXED";
      expect(result.findings[0]?.isResolved).toBe(resolved);
      expect(result.findings[0]?.isBlocking).toBe(!resolved);
      expect(result.verdict).toBe(resolved ? "APPROVE" : "CHANGES_REQUESTED");
    },
  );
  it("ignores reviewer-like comments by another author", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(fixture("pr-134.md"), { authorLogin: "contributor" })],
    });

    expect(result).toMatchObject({ status: "PENDING", findings: [], evaluatedCommitSha: null });
  });
  it.each(CHECK_RUN_CONCLUSIONS)(
    "classifies completed %s without a proven review SHA",
    (conclusion) => {
      const result = normalizePrAgentReviewer({ headSha, checkRuns: [check({ conclusion })] });

      expect(result.status).toBe(
        ["success", "skipped", "neutral"].includes(conclusion) ? "SKIPPED" : "FAILED",
      );
      expect(result.isFresh).toBe(true);
      expect(result.verdict).toBe("NONE");
    },
  );
  it.each(["queued", "in_progress"] as const)("preserves %s execution", (status) => {
    const result = normalizePrAgentReviewer({
      headSha,
      checkRuns: [check({ status, conclusion: null })],
    });

    expect(result.status).toBe("PENDING");
  });
  it("does not use an old success comment to bypass a failed current check", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(stateComment())],
      checkRuns: [check({ conclusion: "failure" })],
    });

    expect(result.status).toBe("FAILED");
    expect(result.findings).toHaveLength(1);
  });
  it("selects the last updated comment without mutating input", () => {
    const comments = [
      comment(stateComment(false), { id: 2, updatedAt: "2026-11-20T00:00:00Z" }),
      comment(stateComment(true)),
    ];

    const result = normalizePrAgentReviewer({ headSha, conversationComments: comments });

    expect(result.status).toBe("PENDING");
    expect(comments[0]?.id).toBe(2);
  });

  it("exports adapter metadata and fails closed on malformed state JSON", () => {
    expect(prAgentNormalizer.reviewerId).toBe("pr-agent");
    expect(prAgentNormalizer.reviewerName).toBe("PR-Agent");

    const malformed = "<!-- pr-agent:review:full -->\n<!-- pr-agent-review-state:v1 {not-json -->";
    const result = prAgentNormalizer.normalize({
      headSha,
      conversationComments: [comment(malformed, { authorLogin: "github-actions" })],
    });

    expect(result).toMatchObject({
      status: "PENDING",
      evaluatedCommitSha: null,
      isFresh: false,
      verdict: "NONE",
      findings: [],
    });
  });

  it("selects the latest PR-Agent check run and marks older check runs STALE", () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const checks = [
      check({ id: 10, conclusion: "failure" }),
      check({ id: 20, commitSha: oldSha, conclusion: "success" }),
    ];

    const result = normalizePrAgentReviewer({ headSha, checkRuns: checks });

    expect(result).toMatchObject({
      status: "STALE",
      evaluatedCommitSha: oldSha,
      isFresh: false,
      verdict: "NONE",
      checkRunConclusion: "success",
    });
    expect(checks[0]?.id).toBe(10);
  });

  it("ignores None/N/A compliance entries and handles optional state finding metadata", () => {
    const commentBody = [
      "<!-- pr-agent:review:full -->",
      "<!-- pr-agent-review-state:v1",
      JSON.stringify({
        schema_version: 1,
        last_run: { head_sha: headSha, complete: true },
        findings: [{ finding_id: "empty", body: "", state: "ACTIVE" }],
      }),
      "-->",
      "Ticket compliance analysis",
      "Non-compliant requirements:",
      "- None.",
      "- N/A",
      "Compliant requirements:",
      "- Should not emit finding",
    ].join("\n");

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(commentBody)],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      id: "pr-agent-empty",
      title: "PR-Agent finding",
      isBlocking: true,
    });
    expect(result.findings[0]?.filePath).toBeUndefined();
    expect(result.findings[0]?.lineNumber).toBeUndefined();
  });

  it("extracts numbered items, skips empty bullet lines, and compares hex SHAs and states case-insensitively", () => {
    const commentBody = [
      "<!-- pr-agent:review:full -->",
      "<!-- pr-agent-review-state:v1",
      JSON.stringify({
        schema_version: 1,
        last_run: { head_sha: headSha.toUpperCase(), complete: true },
        findings: [{ finding_id: "lower", body: "Resolved finding", state: "resolved" }],
      }),
      "-->",
      "Ticket compliance analysis",
      "Non-compliant requirements:",
      "*    ",
      "1.    ",
      "1. Numbered compliance item",
    ].join("\n");

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(commentBody)],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.findings.find((f) => f.id === "pr-agent-lower")?.isResolved).toBe(true);
    expect(result.findings.find((f) => f.description === "Numbered compliance item")).toBeDefined();
  });

  it("prefers the latest proven-current comment over a newer stale-SHA comment edited later", () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const currentComment = comment(
      `${stateComment(true, "ACTIVE").replace(headSha, headSha.toUpperCase())}\nTicket compliance analysis\nNon-compliant requirements:\n- Current head concern`,
      { id: 10, createdAt: "2026-11-19T10:00:00Z", updatedAt: "2026-11-19T10:05:00Z" },
    );
    const newerStaleComment = comment(stateComment(true, "RESOLVED").replace(headSha, oldSha), {
      id: 11,
      createdAt: "2026-11-19T09:00:00Z",
      updatedAt: "2026-11-20T12:00:00Z",
    });

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [newerStaleComment, currentComment],
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      evaluatedCommitSha: headSha,
      isFresh: true,
      verdict: "CHANGES_REQUESTED",
    });
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "pr-agent-10-ticket-1",
      "pr-agent-finding-1",
    ]);
  });

  it("keeps conservative PENDING handling for a newer SHA-less comment when no proven-current comment exists", () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const olderStaleComment = comment(stateComment(true, "RESOLVED").replace(headSha, oldSha), {
      id: 10,
      updatedAt: "2026-11-19T10:00:00Z",
    });
    const newerShaLessComment = comment(fixture("pr-133.md"), {
      id: 11,
      updatedAt: "2026-11-20T12:00:00Z",
    });

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [olderStaleComment, newerShaLessComment],
    });

    expect(result).toMatchObject({
      status: "PENDING",
      evaluatedCommitSha: null,
      isFresh: false,
      verdict: "CHANGES_REQUESTED",
    });
    expect(result.findings.map((finding) => finding.description)).toEqual([
      "Set required_reviewers to [deepseek-review] in .github/merge-verdict.yml (not part of this PR's diff; may have been done in a prior PR).",
    ]);
  });

  it("parses literal --> inside state JSON strings without truncating or leaking into ticket findings", () => {
    const body = [
      "<!-- pr-agent:review:full -->",
      "<!-- pr-agent-review-state:v1",
      JSON.stringify({
        schema_version: 1,
        last_run: { head_sha: headSha, complete: true },
        findings: [
          {
            finding_id: "arrow-finding",
            body: 'Check arrow a --> b and "quoted --> tail"\nTicket compliance analysis\nNon-compliant requirements:\n- Must not leak from state',
            path: "src/normalizers/pr-agent.ts",
            line_start: 29,
            state: "ACTIVE",
          },
        ],
      }),
      "-->",
      "Ticket compliance analysis",
      "Non-compliant requirements:",
      "- Explicit markdown non-compliance",
    ].join("\n");

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(body)],
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      evaluatedCommitSha: headSha,
      isFresh: true,
      verdict: "CHANGES_REQUESTED",
    });
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "pr-agent-1-ticket-1",
      "pr-agent-arrow-finding",
    ]);
    expect(result.findings[1]?.description).toContain("a --> b");
  });

  it.each([
    '<!-- pr-agent-review-state:v1 {"schema_version":1,"last_run":{"head_sha":"f938eb23b9b6d7c9d48f9c439b02b36803f989a3","complete":true},"findings":[{"finding_id":"f1","body":"a --> b","state":"RESOLVED"}]}',
    '<!-- pr-agent-review-state:v1 {"schema_version":1,"last_run":{"head_sha":"f938eb23b9b6d7c9d48f9c439b02b36803f989a3","complete":true},"findings":[]} trailing -->',
    '<!-- pr-agent-review-state:v1 {"schema_version":1,"findings":[{"body":"a --> b"}] broken -->',
    "<!-- pr-agent-review-state:v1 {not-json} -->",
    "<!-- pr-agent-review-state:v1 not-json -->",
  ])(
    "fails closed on malformed or unclosed state tail %s without recovering approval via header",
    (malformedTail) => {
      const body = [
        "<!-- pr-agent:review:full -->",
        `#### (Review updated until commit https://github.com/fixture-owner/merge-verdict/commit/${headSha})`,
        malformedTail,
      ].join("\n");

      const result = normalizePrAgentReviewer({
        headSha,
        repository: "fixture-owner/merge-verdict",
        conversationComments: [comment(body)],
        checkRuns: [check()],
      });

      expect(result).toMatchObject({
        status: "PENDING",
        evaluatedCommitSha: null,
        isFresh: false,
        verdict: "NONE",
      });
    },
  );

  it("bounds ticket compliance across multi-cell tables, sibling headings, and wrapped references", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      repository: "fixture-owner/merge-verdict",
      conversationComments: [comment(fixture("synthetic-ticket-boundaries.md"))],
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      evaluatedCommitSha: headSha,
      isFresh: true,
      verdict: "CHANGES_REQUESTED",
    });
    expect(result.findings.map((finding) => finding.description)).toEqual([
      "Handle wrapped reference for [127](https://github.com/fixture-owner/merge-verdict/issues/127) and [131](https://github.com/fixture-owner/merge-verdict/issues/131)",
      "[148](https://github.com/fixture-owner/merge-verdict/issues/148) / [127](https://github.com/fixture-owner/merge-verdict/issues/127): retain explicit multi-ticket compliance bullet",
    ]);
  });

  it("stops ticket compliance at sibling ## headings without an HTML table", () => {
    const body = [
      "<!-- pr-agent:review:full -->",
      `#### (Review updated until commit https://github.com/fixture-owner/merge-verdict/commit/${headSha})`,
      "## Ticket compliance analysis",
      "Non-compliant requirements:",
      "- Keep first section bullet",
      "## Recommended focus areas",
      "Non-compliant requirements:",
      "- Ignore sibling heading bullet",
    ].join("\n");

    const result = normalizePrAgentReviewer({
      headSha,
      repository: "fixture-owner/merge-verdict",
      conversationComments: [comment(body)],
    });

    expect(result.findings.map((finding) => finding.description)).toEqual([
      "Keep first section bullet",
    ]);
  });

  it("retains multi-ticket non-compliance and ACTIVE state findings from captured PR #154 fixture", () => {
    const pr154Sha = "43adf935e4009a5e864b26f36ee56669c672ad26";
    const result = normalizePrAgentReviewer({
      headSha: pr154Sha,
      repository: "fixture-owner/merge-verdict",
      conversationComments: [comment(fixture("pr-154-multi-ticket.md"))],
      checkRuns: [check({ commitSha: pr154Sha })],
    });

    expect(result).toMatchObject({
      status: "PENDING",
      evaluatedCommitSha: pr154Sha,
      isFresh: true,
      verdict: "CHANGES_REQUESTED",
    });
    const ticketItems = result.findings.filter((f) => f.severity === "HIGH");
    const stateActiveItems = result.findings.filter(
      (f) => f.severity === "MEDIUM" && !f.isResolved,
    );
    const stateResolvedItems = result.findings.filter(
      (f) => f.severity === "MEDIUM" && f.isResolved,
    );
    expect(ticketItems).toHaveLength(10);
    expect(stateActiveItems).toHaveLength(2);
    expect(stateResolvedItems).toHaveLength(1);
  });

  it("fails closed when a completed PR-Agent check has null conclusion", () => {
    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(stateComment(true, "RESOLVED"))],
      checkRuns: [check({ status: "completed", conclusion: null })],
    });

    expect(result).toMatchObject({
      status: "FAILED",
      evaluatedCommitSha: headSha,
      isFresh: true,
      verdict: "NONE",
      checkRunConclusion: null,
    });
  });

  function makePrData(overrides: Partial<GitHubPullRequestData>): GitHubPullRequestData {
    return {
      repository: "fixture-owner/merge-verdict",
      pullRequestNumber: 148,
      headSha,
      baseSha: "0".repeat(40),
      headRef: "fix/issue-148",
      baseRef: "main",
      isFork: false,
      isDraft: false,
      mergeable: true,
      authorLogin: "contributor",
      evaluationSha: headSha,
      policyVersion: "1",
      changedFilePaths: [],
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
      checkRuns: [],
      commitStatuses: [],
      ancestorCommitShas: [],
      policyContent: "",
      ...overrides,
    };
  }

  it("canonicalizes uppercase 40-char hex SHAs across snapshot normalization and policy evaluation", () => {
    const upperHead = headSha.toUpperCase();
    const config = createDefaultConfig();
    config.requiredChecks = [];
    config.requiredReviewers = ["pr-agent"];

    const snapshot = buildReviewSnapshotFromPullRequest(
      makePrData({
        headSha: upperHead,
        evaluationSha: upperHead,
        conversationComments: [comment(stateComment(true, "RESOLVED"))],
        checkRuns: [check({ commitSha: upperHead, conclusion: "success" })],
      }),
      { capturedAt: "2026-11-22T00:00:00Z" },
    );

    expect(snapshot.reviewers["pr-agent"]?.evaluatedCommitSha).toBe(headSha);
    expect(snapshot.reviewers["pr-agent"]?.isFresh).toBe(true);

    const evaluation = evaluatePolicy({
      snapshot,
      config,
      finalSnapshot: { headSha, stateFingerprint: snapshot.stateFingerprint },
      executionErrors: [],
      repositoryRules: [],
      codeEvidenceSatisfied: true,
    });

    expect(evaluation.verdict).toBe("PASS");
    expect(evaluation.reasons).toEqual([]);
  });

  it.each([
    {
      name: "FAILED from null conclusion",
      comments: [comment(stateComment(true, "RESOLVED"))],
      checks: [check({ status: "completed", conclusion: null })],
      expectedReviewerStatus: "FAILED",
      expectedPolicyVerdict: "ERROR",
    },
    {
      name: "PENDING from malformed state tail",
      comments: [
        comment(
          `<!-- pr-agent:review:full -->\n#### (Review updated until commit https://github.com/fixture-owner/merge-verdict/commit/${headSha})\n<!-- pr-agent-review-state:v1 {"schema_version":1`,
        ),
      ],
      checks: [check({ status: "completed", conclusion: "success" })],
      expectedReviewerStatus: "PENDING",
      expectedPolicyVerdict: "PENDING",
    },
    {
      name: "SKIPPED from check success without comment",
      comments: [],
      checks: [check({ status: "completed", conclusion: "success" })],
      expectedReviewerStatus: "SKIPPED",
      expectedPolicyVerdict: "PENDING",
    },
    {
      name: "STALE from old check and old review",
      comments: [comment(stateComment(true, "RESOLVED").replace(headSha, "1".repeat(40)))],
      checks: [check({ commitSha: "1".repeat(40), status: "completed", conclusion: "success" })],
      expectedReviewerStatus: "STALE",
      expectedPolicyVerdict: "PENDING",
    },
  ])(
    "never satisfies required-reviewer completion for $name",
    ({ comments, checks, expectedReviewerStatus, expectedPolicyVerdict }) => {
      const config = createDefaultConfig();
      config.requiredChecks = [];
      config.requiredReviewers = ["pr-agent"];

      const snapshot = buildReviewSnapshotFromPullRequest(
        makePrData({
          conversationComments: comments,
          checkRuns: checks,
        }),
        { capturedAt: "2026-11-22T00:00:00Z" },
      );

      expect(snapshot.reviewers["pr-agent"]?.status).toBe(expectedReviewerStatus);

      const evaluation = evaluatePolicy({
        snapshot,
        config,
        finalSnapshot: { headSha, stateFingerprint: snapshot.stateFingerprint },
        executionErrors: [],
        repositoryRules: [],
        codeEvidenceSatisfied: true,
      });

      expect(evaluation.verdict).toBe(expectedPolicyVerdict);
    },
  );

  function digest(body: string): string {
    return createHash("sha256").update(body).digest("hex");
  }

  it("prefers the artifact-attested PR-Agent comment over a spoofed newer github-actions[bot] comment", () => {
    const authenticBody = stateComment(true, "ACTIVE");
    const spoofedCleanBody = stateComment(true, "RESOLVED");

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [
        comment(authenticBody, {
          id: 101,
          bodyDigest: digest(authenticBody),
          createdAt: "2026-11-22T09:00:00Z",
        }),
        comment(spoofedCleanBody, {
          id: 202,
          bodyDigest: digest(spoofedCleanBody),
          createdAt: "2026-11-22T09:05:00Z",
        }),
      ],
      checkRuns: [check({ appSlug: "github-actions" })],
      prAgentProvenance: {
        status: "verified",
        workflowPath: ".github/workflows/pr-agent.yml",
        runId: 5001,
        headSha,
        commentId: 101,
        bodyDigest: digest(authenticBody),
      },
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      verdict: "CHANGES_REQUESTED",
      isFresh: true,
      evaluatedCommitSha: headSha,
    });
    expect(result.findings.some((finding) => finding.isBlocking && !finding.isResolved)).toBe(true);
  });

  it("rejects tampered comment bodies and unverified or unavailable workflow provenance", () => {
    const cleanBody = stateComment(true, "RESOLVED");

    const tampered = normalizePrAgentReviewer({
      headSha,
      conversationComments: [
        comment(`${cleanBody}\n<!-- edited -->`, {
          id: 101,
          bodyDigest: digest(`${cleanBody}\n<!-- edited -->`),
        }),
      ],
      checkRuns: [check({ appSlug: "github-actions" })],
      prAgentProvenance: {
        status: "verified",
        workflowPath: ".github/workflows/pr-agent.yml",
        runId: 5001,
        headSha,
        commentId: 101,
        bodyDigest: digest(cleanBody),
      },
    });
    expect(tampered.status).toBe("PENDING");
    expect(tampered.verdict).toBe("NONE");
    expect(tampered.isFresh).toBe(false);

    for (const provenanceStatus of ["unverified", "unavailable"] as const) {
      const blocked = normalizePrAgentReviewer({
        headSha,
        conversationComments: [
          comment(cleanBody, {
            id: 101,
            bodyDigest: digest(cleanBody),
          }),
        ],
        checkRuns: [check({ appSlug: "github-actions" })],
        prAgentProvenance: {
          status: provenanceStatus,
          workflowPath: null,
          runId: null,
          headSha: null,
          commentId: null,
          bodyDigest: null,
        },
      });
      expect(blocked.status).toBe("PENDING");
      expect(blocked.verdict).not.toBe("APPROVE");
    }
  });

  it("retains findings while withholding COMPLETED approval when unverified comment reports blocking items", () => {
    const blockingBody = stateComment(true, "ACTIVE");

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(blockingBody, { id: 101, bodyDigest: digest(blockingBody) })],
      checkRuns: [check({ appSlug: "github-actions" })],
      prAgentProvenance: {
        status: "unverified",
        workflowPath: ".github/workflows/other.yml",
        runId: 999,
        headSha: null,
        commentId: null,
        bodyDigest: null,
      },
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings.some((finding) => finding.isBlocking && !finding.isResolved)).toBe(true);
  });

  it("ignores runner / pr-agent check runs whose appSlug is not github-actions", () => {
    const cleanBody = stateComment(true, "RESOLVED");

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(cleanBody, { id: 101, bodyDigest: digest(cleanBody) })],
      checkRuns: [
        check({
          name: "runner / pr-agent",
          appSlug: "untrusted-app",
          conclusion: "failure",
        }),
      ],
      prAgentProvenance: {
        status: "verified",
        workflowPath: ".github/workflows/pr-agent.yml",
        runId: 5001,
        headSha,
        commentId: 101,
        bodyDigest: digest(cleanBody),
      },
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("APPROVE");
    expect(result.checkRunConclusion).toBeNull();
  });

  it("clears evaluatedCommitSha when unverified current-head comment lacks check confirmation", () => {
    const partialBody = stateComment(false, "ACTIVE");

    const result = normalizePrAgentReviewer({
      headSha,
      conversationComments: [comment(partialBody, { id: 101, bodyDigest: digest(partialBody) })],
      prAgentProvenance: {
        status: "unverified",
        workflowPath: null,
        runId: null,
        headSha: null,
        commentId: null,
        bodyDigest: null,
      },
    });

    expect(result).toMatchObject({
      status: "PENDING",
      evaluatedCommitSha: null,
      isFresh: false,
      verdict: "CHANGES_REQUESTED",
    });
  });
});
