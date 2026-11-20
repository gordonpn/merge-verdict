import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/models/config.js";
import type { ReviewSnapshot } from "../../src/models/snapshot.js";
import { evaluatePolicy, type PolicyEvaluationInput } from "../../src/policy/evaluator.js";

type Fixture = { -readonly [K in keyof PolicyEvaluationInput]: PolicyEvaluationInput[K] };

function input(): Fixture {
  const config = createDefaultConfig();
  config.requiredChecks = ["test"];
  config.requiredReviewers = ["reviewer"];
  const snapshot: ReviewSnapshot = {
    repository: "owner/repo",
    pullRequestNumber: 1,
    headSha: "head",
    baseSha: "base",
    isDraft: false,
    stateFingerprint: "fingerprint",
    capturedAt: "2026-11-11T00:00:00Z",
    unresolvedThreadCount: 0,
    blockingDecisionCount: 0,
    checkRuns: {
      test: { name: "test", status: "completed", conclusion: "success", commitSha: "head" },
    },
    reviewers: {
      reviewer: {
        reviewerId: "reviewer",
        reviewerName: "Reviewer",
        status: "COMPLETED",
        evaluatedCommitSha: "head",
        isFresh: true,
        verdict: "APPROVE",
        findings: [],
        checkRunConclusion: "success",
      },
    },
  };
  return {
    codeEvidenceSatisfied: true,
    config,
    snapshot,
    finalSnapshot: { headSha: "head", stateFingerprint: "fingerprint" },
    executionErrors: [],
    repositoryRules: [],
  };
}

function check(value: Fixture) {
  const run = value.snapshot.checkRuns.test;
  if (!run) throw new Error("Test fixture requires the test check");
  return run;
}
function reviewer(value: Fixture) {
  const record = value.snapshot.reviewers.reviewer;
  if (!record) throw new Error("Test fixture requires the reviewer");
  return record;
}

describe("evaluatePolicy decision matrix", () => {
  it("passes reconciled evidence without claiming approval eligibility", () => {
    expect(evaluatePolicy(input())).toMatchObject({
      verdict: "PASS",
      reasons: [],
      approvalEligibility: "undetermined",
    });
  });
  it.each(["queued", "in_progress"] as const)("waits for %s CI", (status) => {
    const value = input();
    check(value).status = status;
    expect(evaluatePolicy(value).verdict).toBe("PENDING");
  });
  it.each(["failure", "neutral", "skipped", "cancelled", "timed_out", "action_required"] as const)(
    "fails CI conclusion %s",
    (conclusion) => {
      const value = input();
      check(value).conclusion = conclusion;
      expect(evaluatePolicy(value).verdict).toBe("FAIL");
    },
  );
  it.each(["PENDING", "RATE_LIMITED", "SKIPPED", "EXEMPT"] as const)(
    "waits for %s required reviewer",
    (status) => {
      const value = input();
      reviewer(value).status = status;
      expect(evaluatePolicy(value).verdict).toBe("PENDING");
    },
  );
  it("waits for a missing required reviewer", () => {
    const value = input();
    value.snapshot.reviewers = {};
    expect(evaluatePolicy(value).verdict).toBe("PENDING");
  });
  it("fails unresolved threads without normalized finding coverage", () => {
    const value = input();
    value.snapshot.unresolvedThreadCount = 1;
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  });
  it("fails active review decisions even when the reviewer is stale", () => {
    const value = input();
    reviewer(value).verdict = "CHANGES_REQUESTED";
    reviewer(value).evaluatedCommitSha = "old";
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  });
  it("fails an aggregate active blocking decision", () => {
    const value = input();
    value.snapshot.blockingDecisionCount = 1;
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  });
  it.each(["sha", "freshness", "status"])("waits for stale reviewer evidence from %s", (field) => {
    const value = input();
    if (field === "sha") reviewer(value).evaluatedCommitSha = "old";
    if (field === "freshness") reviewer(value).isFresh = false;
    if (field === "status") reviewer(value).status = "STALE";
    expect(evaluatePolicy(value).verdict).toBe("PENDING");
  });
  it.each(["headSha", "stateFingerprint"] as const)("aborts on changed %s", (field) => {
    const value = input();
    value.finalSnapshot[field] = "changed";
    expect(evaluatePolicy(value).verdict).toBe("STALE");
  });
  it("returns ERROR for execution anomalies", () => {
    const value = input();
    value.executionErrors = ["collection timed out"];
    expect(evaluatePolicy(value)).toMatchObject({
      verdict: "ERROR",
      reasons: [expect.objectContaining({ condition: 7, subject: "collection timed out" })],
    });
  });
  it("enforces caller-evaluated repository constraints", () => {
    const value = input();
    value.repositoryRules = [{ id: "ticket", satisfied: false }];
    expect(evaluatePolicy(value)).toMatchObject({
      verdict: "FAIL",
      reasons: [expect.objectContaining({ condition: 8, subject: "ticket" })],
    });
  });
});

describe("policy edge cases", () => {
  it("waits for missing or old CI evidence", () => {
    const value = input();
    check(value).commitSha = "old";
    expect(evaluatePolicy(value).verdict).toBe("PENDING");
    value.snapshot.checkRuns = {};
    expect(evaluatePolicy(value).verdict).toBe("PENDING");
  });
  it.each(["neutral", "skipped"] as const)(
    "allows explicitly permitted %s conclusions",
    (conclusion) => {
      const value = input();
      check(value).conclusion = conclusion;
      value.permittedCheckConclusions = { test: [conclusion] };
      expect(evaluatePolicy(value).verdict).toBe("PASS");
    },
  );
  it("treats malformed completed CI and failed review execution as errors", () => {
    const value = input();
    check(value).conclusion = null;
    expect(evaluatePolicy(value).verdict).toBe("ERROR");
    check(value).conclusion = "success";
    reviewer(value).status = "FAILED";
    expect(evaluatePolicy(value).verdict).toBe("ERROR");
  });
  it.each(["BLOCKER", "HIGH", "MEDIUM", "LOW"] as const)(
    "enforces unresolved %s findings",
    (severity) => {
      const value = input();
      value.snapshot.unresolvedThreadCount = 1;
      value.unresolvedThreadIds = ["thread"];
      reviewer(value).findings = [
        {
          id: "finding",
          reviewerId: "reviewer",
          threadId: "thread",
          title: "Concern",
          description: "Concern",
          severity,
          isBlocking: false,
          isResolved: false,
        },
      ];
      expect(evaluatePolicy(value).verdict).toBe("FAIL");
      value.config.allowAdvisoryExemptions = true;
      expect(evaluatePolicy(value).verdict).toBe(severity === "LOW" ? "PASS" : "FAIL");
      value.blockingSeverityThreshold = "LOW";
      expect(evaluatePolicy(value).verdict).toBe("FAIL");
      for (const finding of reviewer(value).findings) finding.isResolved = true;
      value.snapshot.unresolvedThreadCount = 0;
      value.unresolvedThreadIds = [];
      expect(evaluatePolicy(value).verdict).toBe("PASS");
    },
  );
  it("does not exempt an explicitly blocking advisory finding", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    reviewer(value).findings = [
      {
        id: "finding",
        reviewerId: "reviewer",
        title: "Concern",
        description: "Concern",
        severity: "LOW",
        isBlocking: true,
        isResolved: false,
      },
    ];
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  });
  it("does not count duplicate advisory findings as coverage of unknown threads", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    value.snapshot.unresolvedThreadCount = 2;
    const finding = {
      id: "one",
      reviewerId: "reviewer",
      threadId: "same",
      title: "Tip",
      description: "Tip",
      severity: "LOW" as const,
      isBlocking: false,
      isResolved: false,
    };
    reviewer(value).findings = [finding, { ...finding, id: "two" }];
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  });
  it("uses ERROR then STALE then FAIL then PENDING precedence and retains all reasons", () => {
    const value = input();
    value.snapshot.reviewers = {};
    value.snapshot.blockingDecisionCount = 1;
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
    value.finalSnapshot.headSha = "new";
    expect(evaluatePolicy(value).verdict).toBe("STALE");
    value.executionErrors = ["timeout"];
    const result = evaluatePolicy(value);
    expect(result.verdict).toBe("ERROR");
    expect(result.reasons.map((reason) => reason.condition)).toEqual([2, 4, 6, 7]);
  });
  it("is deterministic and does not mutate its input", () => {
    const value = input();
    const before = structuredClone(value);
    expect(evaluatePolicy(value)).toEqual(evaluatePolicy(value));
    expect(value).toEqual(before);
  });
});

describe("required code evidence", () => {
  it("waits when required code evidence is missing", () => {
    const value = input();
    delete value.codeEvidenceSatisfied;
    expect(evaluatePolicy(value)).toMatchObject({
      verdict: "PENDING",
      reasons: [expect.objectContaining({ condition: 8, code: "CODE_EVIDENCE_MISSING" })],
    });
  });
  it("fails when required code evidence is unsatisfied", () => {
    const value = input();
    value.codeEvidenceSatisfied = false;
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  });
  it("permits absent code evidence only when protected policy disables the requirement", () => {
    const value = input();
    delete value.codeEvidenceSatisfied;
    value.config.verification.requireCodeEvidence = false;
    expect(evaluatePolicy(value).verdict).toBe("PASS");
  });
  it("supports explicit MEDIUM exemption without exempting HIGH or BLOCKER", () => {
    const value = input();
    value.blockingSeverityThreshold = "HIGH";
    value.config.allowAdvisoryExemptions = true;
    reviewer(value).findings = [
      {
        id: "finding",
        reviewerId: "reviewer",
        title: "Concern",
        description: "Concern",
        severity: "MEDIUM",
        isBlocking: false,
        isResolved: false,
      },
    ];
    expect(evaluatePolicy(value).verdict).toBe("PASS");
    for (const finding of reviewer(value).findings) finding.severity = "HIGH";
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
    for (const finding of reviewer(value).findings) finding.severity = "BLOCKER";
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  });
});

it("treats prototype names as ordinary own check and exception keys", () => {
  const value = input();
  value.config.requiredChecks = ["toString"];
  value.snapshot.checkRuns = Object.fromEntries([
    [
      "toString",
      {
        name: "toString",
        status: "completed",
        conclusion: "neutral",
        commitSha: "head",
      },
    ],
  ]);
  value.permittedCheckConclusions = {};
  expect(evaluatePolicy(value).verdict).toBe("FAIL");
});
it("does not satisfy required evidence from inherited records", () => {
  const value = input();
  value.snapshot.checkRuns = Object.create(value.snapshot.checkRuns);
  expect(evaluatePolicy(value).verdict).toBe("PENDING");
  value.snapshot.checkRuns = input().snapshot.checkRuns;
  value.snapshot.reviewers = Object.create(value.snapshot.reviewers);
  expect(evaluatePolicy(value).verdict).toBe("PENDING");
});

it("rejects cancelled CI even when an untyped caller permits it", () => {
  const value = input();
  check(value).conclusion = "cancelled";
  value.permittedCheckConclusions = JSON.parse('{"test":["cancelled"]}');
  expect(evaluatePolicy(value).verdict).toBe("FAIL");
});
it.each([undefined, ["other"], [], ["thread", "thread"]].map((ids) => ({ ids })))(
  "fails closed for absent, unrelated, or inconsistent thread identities: %j",
  ({ ids }) => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    value.snapshot.unresolvedThreadCount = 1;
    if (ids !== undefined) value.unresolvedThreadIds = ids;
    reviewer(value).findings = [
      {
        id: "finding",
        reviewerId: "reviewer",
        threadId: "thread",
        title: "Tip",
        description: "Tip",
        severity: "LOW",
        isBlocking: false,
        isResolved: false,
      },
    ];
    expect(evaluatePolicy(value).verdict).toBe("FAIL");
  },
);

describe("rate-limit timeout exemptions", () => {
  it("exempts RATE_LIMITED reviewer when allowAdvisoryExemptions is true and timeout has elapsed", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    value.config.rateLimitTimeoutMinutes = 30;
    value.snapshot.capturedAt = "2026-11-11T00:30:00.000Z";
    reviewer(value).status = "RATE_LIMITED";
    reviewer(value).rateLimitedAt = "2026-11-11T00:00:00.000Z";
    reviewer(value).isFresh = false;
    reviewer(value).verdict = "NONE";

    expect(evaluatePolicy(value)).toMatchObject({
      verdict: "PASS",
      reasons: [],
      exemptedReviewerIds: ["reviewer"],
    });
  });

  it("keeps comment-only RATE_LIMITED reviewer without head provenance pending after timeout", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    value.config.rateLimitTimeoutMinutes = 15;
    value.snapshot.capturedAt = "2026-11-11T00:20:00Z";
    reviewer(value).status = "RATE_LIMITED";
    reviewer(value).evaluatedCommitSha = null;
    reviewer(value).isFresh = false;
    reviewer(value).verdict = "NONE";
    reviewer(value).rateLimitedAt = "2026-11-11T00:00:00Z";

    expect(evaluatePolicy(value)).toMatchObject({
      verdict: "PENDING",
      exemptedReviewerIds: [],
    });
  });

  it("stays PENDING just before rateLimitTimeoutMinutes elapses", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    value.config.rateLimitTimeoutMinutes = 30;
    value.snapshot.capturedAt = "2026-11-11T00:29:59.999Z";
    reviewer(value).status = "RATE_LIMITED";
    reviewer(value).rateLimitedAt = "2026-11-11T00:00:00.000Z";
    reviewer(value).isFresh = false;

    const result = evaluatePolicy(value);
    expect(result.verdict).toBe("PENDING");
    expect(result.reasons).toContainEqual({
      condition: 2,
      outcome: "PENDING",
      code: "REVIEWER_INCOMPLETE",
      subject: "reviewer",
    });
  });

  it("stays PENDING when allowAdvisoryExemptions is false even after timeout", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = false;
    value.config.rateLimitTimeoutMinutes = 30;
    value.snapshot.capturedAt = "2026-11-11T02:00:00Z";
    reviewer(value).status = "RATE_LIMITED";
    reviewer(value).rateLimitedAt = "2026-11-11T00:00:00Z";

    expect(evaluatePolicy(value)).toMatchObject({
      verdict: "PENDING",
      reasons: [
        {
          condition: 2,
          outcome: "PENDING",
          code: "REVIEWER_INCOMPLETE",
          subject: "reviewer",
        },
      ],
    });
  });

  it.each([undefined, "not-a-timestamp", "2026-11-11T01:00:00Z"])(
    "stays PENDING for absent, invalid, or future rateLimitedAt (%j)",
    (rateLimitedAt) => {
      const value = input();
      value.config.allowAdvisoryExemptions = true;
      value.config.rateLimitTimeoutMinutes = 30;
      value.snapshot.capturedAt = "2026-11-11T00:45:00Z";
      reviewer(value).status = "RATE_LIMITED";
      if (rateLimitedAt !== undefined) {
        reviewer(value).rateLimitedAt = rateLimitedAt;
      }

      expect(evaluatePolicy(value)).toMatchObject({
        verdict: "PENDING",
        reasons: [
          {
            condition: 2,
            outcome: "PENDING",
            code: "REVIEWER_INCOMPLETE",
            subject: "reviewer",
          },
        ],
      });
    },
  );

  it("stays PENDING when RATE_LIMITED reviewer evaluated an older commit SHA", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    value.config.rateLimitTimeoutMinutes = 30;
    value.snapshot.capturedAt = "2026-11-11T01:00:00Z";
    reviewer(value).status = "RATE_LIMITED";
    reviewer(value).evaluatedCommitSha = "older-commit";
    reviewer(value).isFresh = false;
    reviewer(value).rateLimitedAt = "2026-11-11T00:00:00Z";

    const result = evaluatePolicy(value);
    expect(result.verdict).toBe("PENDING");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "REVIEWER_INCOMPLETE",
      "REVIEWER_STALE",
    ]);
  });

  it.each([0, -10, Number.NaN])(
    "fails closed when rateLimitTimeoutMinutes is invalid (%s)",
    (timeout) => {
      const value = input();
      value.config.allowAdvisoryExemptions = true;
      value.config.rateLimitTimeoutMinutes = timeout;
      value.snapshot.capturedAt = "2026-11-11T01:00:00Z";
      reviewer(value).status = "RATE_LIMITED";
      reviewer(value).rateLimitedAt = "2026-11-11T00:00:00Z";

      expect(evaluatePolicy(value).verdict).toBe("PENDING");
    },
  );

  it("never waives unresolved blocking findings or CHANGES_REQUESTED on exempted RATE_LIMITED reviewer", () => {
    const value = input();
    value.config.allowAdvisoryExemptions = true;
    value.config.rateLimitTimeoutMinutes = 30;
    value.snapshot.capturedAt = "2026-11-11T01:00:00Z";
    value.snapshot.unresolvedThreadCount = 1;
    value.unresolvedThreadIds = ["thread-1"];
    reviewer(value).status = "RATE_LIMITED";
    reviewer(value).isFresh = false;
    reviewer(value).verdict = "CHANGES_REQUESTED";
    reviewer(value).rateLimitedAt = "2026-11-11T00:00:00Z";
    reviewer(value).findings = [
      {
        id: "finding-1",
        reviewerId: "reviewer",
        threadId: "thread-1",
        title: "Security issue",
        description: "Security issue",
        severity: "HIGH",
        isBlocking: true,
        isResolved: false,
      },
    ];

    const result = evaluatePolicy(value);
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons).toEqual([
      {
        condition: 3,
        outcome: "FAIL",
        code: "UNRESOLVED_FINDING",
        subject: "finding-1",
      },
      {
        condition: 4,
        outcome: "FAIL",
        code: "CHANGES_REQUESTED",
        subject: "reviewer",
      },
    ]);
  });
});
