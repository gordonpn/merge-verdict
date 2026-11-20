import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  GitHubCheckRun,
  GitHubConversationComment,
} from "../../src/collector/github-collector.js";
import { CHECK_RUN_CONCLUSIONS } from "../../src/models/check-run.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { normalizePrAgentReviewer, prAgentNormalizer } from "../../src/normalizers/pr-agent.js";

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
});
