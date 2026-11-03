import { describe, expect, it } from "vitest";
import {
  REVIEWER_STATUSES,
  REVIEWER_VERDICTS,
  ReviewerExecutionRecordSchema,
  ReviewerStatusSchema,
  ReviewerVerdictSchema,
} from "../../src/models/reviewer.js";

describe("ReviewerStatusSchema", () => {
  it("parses all valid reviewer status variants", () => {
    for (const status of REVIEWER_STATUSES) {
      expect(ReviewerStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects invalid reviewer status values", () => {
    const invalidStatuses = ["SUCCESS", "RUNNING", "PASSED", "", "unknown"];
    for (const invalid of invalidStatuses) {
      expect(() => ReviewerStatusSchema.parse(invalid)).toThrow();
    }
  });
});

describe("ReviewerVerdictSchema", () => {
  it("parses all valid reviewer verdicts", () => {
    for (const verdict of REVIEWER_VERDICTS) {
      expect(ReviewerVerdictSchema.parse(verdict)).toBe(verdict);
    }
  });

  it("rejects invalid reviewer verdicts", () => {
    const invalidVerdicts = ["PASS", "FAIL", "REJECT", "", "BLOCK"];
    for (const invalid of invalidVerdicts) {
      expect(() => ReviewerVerdictSchema.parse(invalid)).toThrow();
    }
  });
});

describe("ReviewerExecutionRecordSchema", () => {
  const validRecord = {
    reviewerId: "coderabbitai",
    reviewerName: "CodeRabbit",
    status: "COMPLETED" as const,
    evaluatedCommitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    isFresh: true,
    verdict: "APPROVE" as const,
    summary: "All verification checks passed.",
    findings: [],
    checkRunConclusion: "success",
  };

  it("parses valid reviewer execution record", () => {
    const parsed = ReviewerExecutionRecordSchema.parse(validRecord);
    expect(parsed.reviewerId).toBe("coderabbitai");
    expect(parsed.status).toBe("COMPLETED");
  });

  it("parses record with nullable evaluatedCommitSha and checkRunConclusion", () => {
    const nullableRecord = {
      ...validRecord,
      evaluatedCommitSha: null,
      checkRunConclusion: null,
    };
    const parsed = ReviewerExecutionRecordSchema.parse(nullableRecord);
    expect(parsed.evaluatedCommitSha).toBeNull();
    expect(parsed.checkRunConclusion).toBeNull();
  });

  it("rejects record with malformed findings array", () => {
    const invalid = {
      ...validRecord,
      findings: [{ id: "bad-finding" }],
    };
    expect(() => ReviewerExecutionRecordSchema.parse(invalid)).toThrow();
  });

  it("rejects missing mandatory fields", () => {
    const mandatoryKeys = [
      "reviewerId",
      "reviewerName",
      "status",
      "isFresh",
      "verdict",
      "findings",
    ] as const;

    for (const key of mandatoryKeys) {
      const incomplete = { ...validRecord };
      delete (incomplete as Record<string, unknown>)[key];
      expect(() => ReviewerExecutionRecordSchema.parse(incomplete)).toThrow();
    }
  });
});
