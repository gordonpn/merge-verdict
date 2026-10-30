import { describe, expect, it } from "vitest";
import {
  computeStateFingerprint,
  createReviewSnapshot,
  ReviewSnapshotSchema,
} from "../../src/models/snapshot.js";

describe("ReviewSnapshotSchema", () => {
  const sampleReviewer = {
    reviewerId: "coderabbitai",
    reviewerName: "CodeRabbit",
    status: "COMPLETED" as const,
    evaluatedCommitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    isFresh: true,
    verdict: "APPROVE" as const,
    findings: [],
    checkRunConclusion: "success",
  };

  const sampleCheckRun = {
    name: "runner / test",
    status: "completed" as const,
    conclusion: "success" as const,
    commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  };

  const validSnapshotInput = {
    repository: "owner/repo",
    pullRequestNumber: 123,
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    baseSha: "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
    isDraft: false,
    unresolvedThreadCount: 0,
    blockingDecisionCount: 0,
    reviewers: {
      coderabbitai: sampleReviewer,
    },
    checkRuns: {
      "runner / test": sampleCheckRun,
    },
  };

  it("creates and parses a valid review snapshot using createReviewSnapshot", () => {
    const snapshot = createReviewSnapshot(validSnapshotInput);
    expect(snapshot.repository).toBe("owner/repo");
    expect(snapshot.pullRequestNumber).toBe(123);
    expect(snapshot.stateFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(ReviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects non-positive pull request numbers", () => {
    expect(() => createReviewSnapshot({ ...validSnapshotInput, pullRequestNumber: 0 })).toThrow();
    expect(() => createReviewSnapshot({ ...validSnapshotInput, pullRequestNumber: -1 })).toThrow();
  });

  it("rejects negative thread or decision counts", () => {
    expect(() =>
      createReviewSnapshot({
        ...validSnapshotInput,
        unresolvedThreadCount: -1,
      }),
    ).toThrow();
    expect(() =>
      createReviewSnapshot({
        ...validSnapshotInput,
        blockingDecisionCount: -1,
      }),
    ).toThrow();
  });

  it("rejects invalid capturedAt datetime strings", () => {
    const snapshot = createReviewSnapshot(validSnapshotInput);
    expect(() =>
      ReviewSnapshotSchema.parse({
        ...snapshot,
        capturedAt: "not-a-datetime",
      }),
    ).toThrow();
  });
});

describe("computeStateFingerprint", () => {
  const findingOne = {
    id: "f-1",
    reviewerId: "coderabbitai",
    title: "T1",
    description: "D1",
    severity: "MEDIUM" as const,
    isBlocking: true,
    isResolved: false,
  };

  const findingTwo = {
    id: "f-2",
    reviewerId: "coderabbitai",
    title: "T2",
    description: "D2",
    severity: "LOW" as const,
    isBlocking: false,
    isResolved: true,
  };

  const baseInput = {
    headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    unresolvedThreadCount: 1,
    blockingDecisionCount: 0,
    reviewers: {
      coderabbitai: {
        reviewerId: "coderabbitai",
        reviewerName: "CodeRabbit",
        status: "COMPLETED" as const,
        evaluatedCommitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        isFresh: true,
        verdict: "APPROVE" as const,
        findings: [findingOne, findingTwo],
        checkRunConclusion: "success",
      },
      sourcery: {
        reviewerId: "sourcery",
        reviewerName: "Sourcery",
        status: "COMPLETED" as const,
        evaluatedCommitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        isFresh: true,
        verdict: "COMMENTED" as const,
        findings: [],
        checkRunConclusion: null,
      },
    },
    checkRuns: {
      "runner / test": {
        name: "runner / test",
        status: "completed" as const,
        conclusion: "success" as const,
        commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      },
      "runner / lint": {
        name: "runner / lint",
        status: "completed" as const,
        conclusion: "success" as const,
        commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      },
    },
  };

  it("produces deterministic SHA-256 hash for identical input", () => {
    const hash1 = computeStateFingerprint(baseInput);
    const hash2 = computeStateFingerprint(baseInput);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is independent of reviewer object key insertion order", () => {
    const reversedReviewers = {
      sourcery: baseInput.reviewers.sourcery,
      coderabbitai: baseInput.reviewers.coderabbitai,
    };
    const hash1 = computeStateFingerprint(baseInput);
    const hash2 = computeStateFingerprint({
      ...baseInput,
      reviewers: reversedReviewers,
    });
    expect(hash1).toBe(hash2);
  });

  it("is independent of check run object key insertion order", () => {
    const reversedCheckRuns = {
      "runner / lint": baseInput.checkRuns["runner / lint"],
      "runner / test": baseInput.checkRuns["runner / test"],
    };
    const hash1 = computeStateFingerprint(baseInput);
    const hash2 = computeStateFingerprint({
      ...baseInput,
      checkRuns: reversedCheckRuns,
    });
    expect(hash1).toBe(hash2);
  });

  it("is independent of findings array order within reviewer", () => {
    const reversedFindings = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [findingTwo, findingOne],
        },
      },
    };
    const hash1 = computeStateFingerprint(baseInput);
    const hash2 = computeStateFingerprint(reversedFindings);
    expect(hash1).toBe(hash2);
  });

  it("changes hash when headSha changes", () => {
    const modified = {
      ...baseInput,
      headSha: "ffffffffffffffffffffffffffffffffffffffff",
    };
    expect(computeStateFingerprint(modified)).not.toBe(computeStateFingerprint(baseInput));
  });

  it("changes hash when finding resolution state changes", () => {
    const modified = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [{ ...findingOne, isResolved: true }, findingTwo],
        },
      },
    };
    expect(computeStateFingerprint(modified)).not.toBe(computeStateFingerprint(baseInput));
  });

  it("changes hash when check run conclusion changes", () => {
    const modified = {
      ...baseInput,
      checkRuns: {
        ...baseInput.checkRuns,
        "runner / test": {
          ...baseInput.checkRuns["runner / test"],
          conclusion: "failure" as const,
        },
      },
    };
    expect(computeStateFingerprint(modified)).not.toBe(computeStateFingerprint(baseInput));
  });

  it("changes hash when unresolvedThreadCount changes", () => {
    const modified = {
      ...baseInput,
      unresolvedThreadCount: 0,
    };
    expect(computeStateFingerprint(modified)).not.toBe(computeStateFingerprint(baseInput));
  });
});
