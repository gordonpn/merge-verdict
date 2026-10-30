import { describe, expect, it } from "vitest";
import { NormalizedFindingSchema } from "../../src/models/finding.js";

describe("NormalizedFindingSchema", () => {
  const validFinding = {
    id: "finding-1",
    reviewerId: "coderabbitai",
    threadId: "PRRT_kwDOUey2HM6w",
    title: "Resource leak in stream handling",
    description: "The readable stream is not closed on error paths.",
    filePath: "src/collector/stream.ts",
    lineNumber: 42,
    severity: "HIGH" as const,
    isBlocking: true,
    isResolved: false,
    resolvedBy: "sourcery-ai[bot]",
    acknowledgedCommitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    rawCommentUrl: "https://github.com/owner/repo/pull/1#discussion_r12345",
  };

  it("parses valid finding with all fields populated", () => {
    const parsed = NormalizedFindingSchema.parse(validFinding);
    expect(parsed).toEqual(validFinding);
  });

  it("parses valid finding with optional fields omitted", () => {
    const minimalFinding = {
      id: "finding-2",
      reviewerId: "sourcery-ai",
      title: "Complexity warning",
      description: "Function cyclomatic complexity exceeds threshold.",
      severity: "LOW" as const,
      isBlocking: false,
      isResolved: true,
    };
    const parsed = NormalizedFindingSchema.parse(minimalFinding);
    expect(parsed.id).toBe("finding-2");
    expect(parsed.threadId).toBeUndefined();
    expect(parsed.filePath).toBeUndefined();
    expect(parsed.lineNumber).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    const requiredKeys = [
      "id",
      "reviewerId",
      "title",
      "description",
      "severity",
      "isBlocking",
      "isResolved",
    ] as const;

    for (const key of requiredKeys) {
      const incomplete = { ...validFinding };
      delete (incomplete as Record<string, unknown>)[key];
      expect(() => NormalizedFindingSchema.parse(incomplete)).toThrow();
    }
  });

  it("rejects invalid severity values", () => {
    const invalid = { ...validFinding, severity: "INVALID_SEVERITY" };
    expect(() => NormalizedFindingSchema.parse(invalid)).toThrow();
  });

  it("rejects invalid rawCommentUrl format", () => {
    const invalid = { ...validFinding, rawCommentUrl: "not-a-valid-url" };
    expect(() => NormalizedFindingSchema.parse(invalid)).toThrow();
  });

  it("rejects invalid line number values", () => {
    const nonPositive = { ...validFinding, lineNumber: 0 };
    expect(() => NormalizedFindingSchema.parse(nonPositive)).toThrow();

    const negative = { ...validFinding, lineNumber: -5 };
    expect(() => NormalizedFindingSchema.parse(negative)).toThrow();

    const nonInteger = { ...validFinding, lineNumber: 12.34 };
    expect(() => NormalizedFindingSchema.parse(nonInteger)).toThrow();
  });
});
