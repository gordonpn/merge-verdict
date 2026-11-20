import { describe, expect, it } from "vitest";
import type {
  GitHubCheckRun,
  GitHubConversationComment,
  GitHubPullRequestData,
  GitHubReviewSubmission,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { parseConfig } from "../../src/config/loader.js";
import { ReviewerExecutionRecordSchema } from "../../src/models/reviewer.js";
import { buildReviewSnapshotFromPullRequest } from "../../src/normalizers/index.js";
import { normalizeSourceryReviewer, sourceryNormalizer } from "../../src/normalizers/sourcery.js";
import { evaluatePolicy } from "../../src/policy/evaluator.js";

describe("normalizeSourceryReviewer", () => {
  const headSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("exports adapter object matching ReviewerNormalizer interface", () => {
    expect(sourceryNormalizer.reviewerId).toBe("sourcery-ai");
    expect(sourceryNormalizer.reviewerName).toBe("Sourcery");
    const result = sourceryNormalizer.normalize({ headSha });
    expect(result.status).toBe("PENDING");
  });

  it("returns PENDING when Sourcery has not executed", () => {
    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns: [],
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
    expect(result.isFresh).toBe(false);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("returns PENDING when check run is in_progress", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 10,
        name: "Sourcery review",
        status: "in_progress",
        conclusion: null,
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("PENDING");
    expect(result.verdict).toBe("NONE");
  });

  it("returns FAILED and CHANGES_REQUESTED when check run conclusion is failure", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 11,
        name: "Sourcery review",
        status: "completed",
        conclusion: "failure",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("rejects neutral check run as FAILED rather than APPROVE", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 111,
        name: "Sourcery review",
        status: "completed",
        conclusion: "neutral",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("NONE");
  });

  it("preserves active CHANGES_REQUESTED review submission even with zero inline threads", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 112,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];
    const reviews: GitHubReviewSubmission[] = [
      {
        id: 301,
        reviewerLogin: "sourcery-ai[bot]",
        state: "CHANGES_REQUESTED",
        commitSha: headSha,
        submittedAt: "2026-10-01T10:00:00Z",
        body: "Changes needed.",
        bodyDigest: "d1",
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews,
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("flags older check run evaluations as STALE", () => {
    const olderSha = "0000000000000000000000000000000000000000";
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 12,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: olderSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeSourceryReviewer({
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

  it("normalizes High/Medium/Low findings and addressed commit acknowledgements", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 13,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_sourcery_1",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/utils.ts",
        line: 12,
        originalLine: 12,
        comments: [
          {
            id: "c1",
            authorLogin: "sourcery-ai[bot]",
            body: "High · Previous defaults carry over\n\nReset default configuration on each invocation.",
            bodyDigest: "d1",
            path: "src/utils.ts",
            line: 12,
            originalLine: 12,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_sourcery_2",
        isResolved: true,
        resolvedByLogin: "sourcery-ai[bot]",
        isOutdated: false,
        path: "src/utils.ts",
        line: 30,
        originalLine: 30,
        comments: [
          {
            id: "c2",
            authorLogin: "sourcery-ai[bot]",
            body: "Addressed in [f1e2d3c4]: First match passes mode test\n\nMedium · First match passes mode test",
            bodyDigest: "d2",
            path: "src/utils.ts",
            line: 30,
            originalLine: 30,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
      {
        id: "thread_sourcery_3",
        isResolved: false,
        resolvedByLogin: null,
        isOutdated: false,
        path: "src/utils.ts",
        line: 45,
        originalLine: 45,
        comments: [
          {
            id: "c3",
            authorLogin: "sourcery-ai[bot]",
            body: "Low · Prefer const over let\n\nVariable is not reassigned.",
            bodyDigest: "d3",
            path: "src/utils.ts",
            line: 45,
            originalLine: 45,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      ancestorCommitShas: [`f1e2d3c4${"0".repeat(32)}`],
      checkRuns,
      reviewThreads,
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("CHANGES_REQUESTED"); // thread_sourcery_1 is unresolved High
    expect(result.findings).toHaveLength(3);

    const [f1, f2, f3] = result.findings;
    expect(f1?.severity).toBe("HIGH");
    expect(f1?.isBlocking).toBe(true);
    expect(f1?.title).toBe("Previous defaults carry over");

    expect(f2?.severity).toBe("MEDIUM");
    expect(f2?.isResolved).toBe(true);
    expect(f2?.isBlocking).toBe(false);
    expect(f2?.acknowledgedCommitSha).toBe("f1e2d3c4");
    expect(f2?.resolvedBy).toBe("sourcery-ai[bot]");

    expect(f3?.severity).toBe("LOW");
    expect(f3?.isBlocking).toBe(false);

    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("returns APPROVE when all findings are resolved and check run is successful", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 14,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_sourcery_resolved",
        isResolved: true,
        resolvedByLogin: "sourcery-ai[bot]",
        isOutdated: false,
        path: "src/utils.ts",
        line: 10,
        originalLine: 10,
        comments: [
          {
            id: "c4",
            authorLogin: "sourcery-ai[bot]",
            body: "Addressed in [e9d8c7b6]: High · Fixed memory leak",
            bodyDigest: "d4",
            path: "src/utils.ts",
            line: 10,
            originalLine: 10,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      ancestorCommitShas: [`e9d8c7b6${"0".repeat(32)}`],
      checkRuns,
      reviewThreads,
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.isFresh).toBe(true);
    expect(result.verdict).toBe("APPROVE");
    expect(result.findings[0]?.isResolved).toBe(true);
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    {
      name: "short ancestor SHA",
      acknowledgedSha: "abcdef1",
      ancestors: [`abcdef1${"0".repeat(33)}`],
      resolved: true,
    },
    {
      name: "case-insensitive ancestor SHA",
      acknowledgedSha: "ABCDEF1",
      ancestors: [`abcdef1${"0".repeat(33)}`],
      resolved: true,
    },
    {
      name: "short head SHA without ancestry",
      acknowledgedSha: "1234567",
      ancestors: undefined,
      resolved: true,
    },
    {
      name: "unproven acknowledgement without ancestry",
      acknowledgedSha: "abcdef1",
      ancestors: undefined,
      resolved: false,
    },
    {
      name: "ambiguous ancestor prefix",
      acknowledgedSha: "abcdef1",
      ancestors: [`abcdef1${"0".repeat(33)}`, `abcdef1${"1".repeat(33)}`],
      resolved: false,
    },
  ])("checks $name before accepting resolution", ({ acknowledgedSha, ancestors, resolved }) => {
    const currentHead = `1234567${"0".repeat(33)}`;
    const result = normalizeSourceryReviewer({
      headSha: currentHead,
      ...(ancestors ? { ancestorCommitShas: ancestors } : {}),
      reviewThreads: [
        {
          id: "acknowledged-thread",
          isResolved: true,
          resolvedByLogin: "sourcery-ai[bot]",
          isOutdated: false,
          path: "src/utils.ts",
          line: 1,
          originalLine: 1,
          comments: [
            {
              id: "acknowledgement",
              authorLogin: "sourcery-ai[bot]",
              body: `Addressed in [${acknowledgedSha}]: High · Fixed bug`,
              bodyDigest: "digest",
              path: "src/utils.ts",
              line: 1,
              originalLine: 1,
              commitSha: currentHead,
              createdAt: "2026-10-01T10:00:00Z",
              updatedAt: "2026-10-01T10:00:00Z",
            },
          ],
        },
      ],
    });
    expect(result.findings[0]?.isResolved).toBe(resolved);
    expect(result.findings[0]?.isBlocking).toBe(!resolved);
  });

  it("treats acknowledged finding as unresolved when acknowledged SHA is not in ancestry", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 15,
        name: "Sourcery review",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const reviewThreads: GitHubReviewThread[] = [
      {
        id: "thread_sourcery_bad_sha",
        isResolved: true,
        resolvedByLogin: "sourcery-ai[bot]",
        isOutdated: false,
        path: "src/utils.ts",
        line: 10,
        originalLine: 10,
        comments: [
          {
            id: "c5",
            authorLogin: "sourcery-ai[bot]",
            body: "Addressed in [badc0ffee123]: High · Fixed bug",
            bodyDigest: "d5",
            path: "src/utils.ts",
            line: 10,
            originalLine: 10,
            commitSha: headSha,
            createdAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ],
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      ancestorCommitShas: ["baseSha123", headSha],
      checkRuns,
      reviewThreads,
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
    expect(result.findings[0]?.isResolved).toBe(false);
    expect(result.findings[0]?.isBlocking).toBe(true);
  });

  it("classifies skipped Sourcery check runs without quota notice as SKIPPED", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 201,
        name: "Sourcery review",
        status: "completed",
        conclusion: "skipped",
        commitSha: headSha,
        detailsUrl: null,
        output: { title: "Skipped", summary: "No eligible files changed.", text: null },
        startedAt: null,
        completedAt: "2026-11-16T02:58:40Z",
      },
    ];

    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns,
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(result.status).toBe("SKIPPED");
    expect(result.verdict).toBe("NONE");
    expect(result.isFresh).toBe(true);
    expect(result.checkRunConclusion).toBe("skipped");
    expect(ReviewerExecutionRecordSchema.safeParse(result).success).toBe(true);
  });

  it("classifies skipped or neutral Sourcery quota-limit runs and comments as RATE_LIMITED", () => {
    const budgetSummary =
      "Sorry @maintainer, you've used your own review budget of 250,000 diff characters for the last 7 days.\n\nYou can request another review in 12 hours and 26 minutes by commenting `@sourcery-ai review`.";

    const skippedQuota = normalizeSourceryReviewer({
      headSha,
      checkRuns: [
        {
          id: 202,
          name: "Sourcery review",
          status: "completed",
          conclusion: "skipped",
          commitSha: headSha,
          detailsUrl: null,
          output: { title: "Skipped", summary: budgetSummary, text: null },
          startedAt: null,
          completedAt: "2026-11-16T02:58:40Z",
        },
      ],
      reviewThreads: [],
      reviews: [],
      conversationComments: [],
    });

    expect(skippedQuota.status).toBe("RATE_LIMITED");
    expect(skippedQuota.verdict).toBe("NONE");
    expect(skippedQuota.isFresh).toBe(true);
    expect(skippedQuota.rateLimitedAt).toBe("2026-11-16T02:58:40Z");
    expect(skippedQuota.checkRunConclusion).toBe("skipped");

    const neutralQuota = normalizeSourceryReviewer({
      headSha,
      checkRuns: [
        {
          id: 203,
          name: "Sourcery review",
          status: "completed",
          conclusion: "neutral",
          commitSha: headSha,
          detailsUrl: null,
          output: { title: "Sourcery review", summary: null, text: null },
          startedAt: null,
          completedAt: "2026-11-16T02:58:30Z",
        },
      ],
      reviewThreads: [],
      reviews: [],
      conversationComments: [
        {
          id: 9001,
          authorLogin: "sourcery-ai",
          body: budgetSummary,
          bodyDigest: "quota-digest",
          createdAt: "2026-11-16T02:58:35Z",
          updatedAt: null,
        } satisfies GitHubConversationComment,
      ],
    });

    expect(neutralQuota.status).toBe("RATE_LIMITED");
    expect(neutralQuota.verdict).toBe("NONE");
    expect(neutralQuota.rateLimitedAt).toBeUndefined();
    expect(ReviewerExecutionRecordSchema.safeParse(neutralQuota).success).toBe(true);
  });

  it("ignores historical Sourcery quota comments once a fresh success check run completes", () => {
    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns: [
        {
          id: 204,
          name: "Sourcery review",
          status: "completed",
          conclusion: "success",
          commitSha: headSha,
          detailsUrl: null,
          output: { title: "Passed", summary: "Review complete.", text: null },
          startedAt: null,
          completedAt: "2026-11-16T03:10:00Z",
        },
      ],
      reviewThreads: [],
      reviews: [],
      conversationComments: [
        {
          id: 9002,
          authorLogin: "sourcery-ai[bot]",
          body: "Sorry @maintainer, you've used your own review budget of 250,000 diff characters for the last 7 days.",
          bodyDigest: "old-quota-digest",
          createdAt: "2026-11-16T02:00:00Z",
          updatedAt: null,
        },
      ],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.verdict).toBe("APPROVE");
  });

  it("ignores empty or pre-check Sourcery quota comments when check run completes without quota notice", () => {
    const result = normalizeSourceryReviewer({
      headSha,
      checkRuns: [
        {
          id: 205,
          name: "Sourcery review",
          status: "completed",
          conclusion: "neutral",
          commitSha: headSha,
          detailsUrl: null,
          output: { title: "Neutral", summary: "Finished with neutral status.", text: null },
          startedAt: null,
          completedAt: "2026-11-16T03:00:00Z",
        },
      ],
      reviewThreads: [],
      reviews: [],
      conversationComments: [
        {
          id: 9003,
          authorLogin: "sourcery-ai",
          body: "Sorry @maintainer, you've used your own review budget of 250,000 diff characters for the last 7 days.",
          bodyDigest: "stale-quota",
          createdAt: "2026-11-16T02:00:00Z",
          updatedAt: null,
        },
        {
          id: 9004,
          authorLogin: "sourcery-ai",
          body: null,
          bodyDigest: null,
          createdAt: "2026-11-16T03:01:00Z",
          updatedAt: null,
        },
        {
          id: 9005,
          authorLogin: "sourcery-ai",
          body: "## Reviewer's Guide\nComment `@sourcery-ai review` to trigger a new review.",
          bodyDigest: "guide-digest",
          createdAt: "2026-11-16T03:02:00Z",
          updatedAt: null,
        },
      ],
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("NONE");
  });

  it("evaluates Sourcery skipped quota runs as PENDING rather than ERROR in policy evaluation", () => {
    const config = parseConfig(
      [
        "required_checks:",
        "  - runner / test",
        "required_reviewers:",
        "  - sourcery-ai",
        "verification:",
        "  require_code_evidence: false",
      ].join("\n"),
    );
    const prData: GitHubPullRequestData = {
      repository: "gordonpn/merge-verdict",
      pullRequestNumber: 112,
      headSha,
      baseSha: "1111111111111111111111111111111111111111",
      headRef: "docs/refresh-next",
      baseRef: "main",
      isFork: false,
      isDraft: false,
      mergeable: true,
      authorLogin: "maintainer",
      evaluationSha: headSha,
      policyVersion: "1111111111111111111111111111111111111111",
      changedFilePaths: ["NEXT.md"],
      reviewThreads: [],
      conversationComments: [],
      reviews: [],
      checkRuns: [
        {
          id: 1,
          name: "runner / test",
          status: "completed",
          conclusion: "success",
          commitSha: headSha,
          detailsUrl: null,
          output: { title: null, summary: null, text: null },
          startedAt: null,
          completedAt: null,
        },
        {
          id: 2,
          name: "Sourcery review",
          status: "completed",
          conclusion: "skipped",
          commitSha: headSha,
          detailsUrl: null,
          output: {
            title: "Skipped",
            summary:
              "Sorry @maintainer, you've used your own review budget of 250,000 diff characters for the last 7 days.",
            text: null,
          },
          startedAt: null,
          completedAt: "2026-11-16T02:58:40Z",
        },
      ],
      commitStatuses: [],
      policyContent: "",
    };

    const snapshot = buildReviewSnapshotFromPullRequest(prData);
    const evaluation = evaluatePolicy({
      snapshot,
      config,
      finalSnapshot: { headSha: snapshot.headSha, stateFingerprint: snapshot.stateFingerprint },
      executionErrors: [],
      repositoryRules: [],
    });

    expect(snapshot.reviewers["sourcery-ai"]?.status).toBe("RATE_LIMITED");
    expect(evaluation.verdict).toBe("PENDING");
    expect(evaluation.reasons).toContainEqual({
      condition: 2,
      outcome: "PENDING",
      code: "REVIEWER_INCOMPLETE",
      subject: "sourcery-ai",
    });
  });
});
