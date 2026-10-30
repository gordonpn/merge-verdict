import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
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

  it("uses explicitly provided stateFingerprint when specified", () => {
    const customFingerprint = "e".repeat(64);
    const snapshot = createReviewSnapshot({
      ...validSnapshotInput,
      stateFingerprint: customFingerprint,
    });
    expect(snapshot.stateFingerprint).toBe(customFingerprint);
  });

  it("uses explicitly provided capturedAt timestamp when specified", () => {
    const customTime = "2026-01-01T00:00:00.000Z";
    const snapshot = createReviewSnapshot({
      ...validSnapshotInput,
      capturedAt: customTime,
    });
    expect(snapshot.capturedAt).toBe(customTime);
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

  it("throws ZodError on creation when reviewer record lacks findings", () => {
    const malformedInput = {
      ...validSnapshotInput,
      reviewers: {
        coderabbitai: {
          reviewerId: "coderabbitai",
          reviewerName: "CodeRabbit",
          status: "COMPLETED" as const,
          evaluatedCommitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
          isFresh: true,
          verdict: "APPROVE" as const,
          checkRunConclusion: "success",
        },
      },
    };

    expect(() =>
      // @ts-expect-error Testing runtime schema validation of malformed input
      createReviewSnapshot(malformedInput),
    ).toThrowError(ZodError);
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
    resolvedBy: "user-1",
    acknowledgedCommitSha: "1111111111111111111111111111111111111111",
  };

  const findingTwo = {
    id: "f-2",
    reviewerId: "coderabbitai",
    title: "T2",
    description: "D2",
    severity: "LOW" as const,
    isBlocking: false,
    isResolved: true,
    resolvedBy: "sourcery-ai[bot]",
    acknowledgedCommitSha: "2222222222222222222222222222222222222222",
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

  it("deterministically breaks ties for findings with duplicate IDs", () => {
    const dupFindingA = {
      id: "dup-id",
      reviewerId: "coderabbitai",
      title: "Alpha finding",
      description: "First finding with dup ID",
      filePath: "src/a.ts",
      lineNumber: 10,
      severity: "HIGH" as const,
      isBlocking: true,
      isResolved: false,
    };
    const dupFindingB = {
      id: "dup-id",
      reviewerId: "coderabbitai",
      title: "Beta finding",
      description: "Second finding with dup ID",
      filePath: "src/b.ts",
      lineNumber: 20,
      severity: "LOW" as const,
      isBlocking: false,
      isResolved: true,
    };

    const orderOne = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [dupFindingA, dupFindingB],
        },
      },
    };

    const orderTwo = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [dupFindingB, dupFindingA],
        },
      },
    };

    expect(computeStateFingerprint(orderOne)).toBe(computeStateFingerprint(orderTwo));
  });

  it("deterministically breaks ties when duplicate IDs share file path", () => {
    const findingLine10 = {
      id: "dup-id",
      reviewerId: "coderabbitai",
      title: "Shared title",
      description: "Description",
      filePath: "src/shared.ts",
      lineNumber: 10,
      severity: "HIGH" as const,
      isBlocking: true,
      isResolved: false,
    };
    const findingLine20 = {
      ...findingLine10,
      lineNumber: 20,
    };

    const orderOne = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [findingLine10, findingLine20],
        },
      },
    };
    const orderTwo = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [findingLine20, findingLine10],
        },
      },
    };

    expect(computeStateFingerprint(orderOne)).toBe(computeStateFingerprint(orderTwo));
  });

  it("deterministically breaks ties when duplicate IDs share file path and line number", () => {
    const findingAlpha = {
      id: "dup-id",
      reviewerId: "coderabbitai",
      title: "Alpha title",
      description: "Description",
      filePath: "src/shared.ts",
      lineNumber: 10,
      severity: "HIGH" as const,
      isBlocking: true,
      isResolved: false,
    };
    const findingBeta = {
      ...findingAlpha,
      title: "Beta title",
    };

    const orderOne = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [findingAlpha, findingBeta],
        },
      },
    };
    const orderTwo = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [findingBeta, findingAlpha],
        },
      },
    };

    expect(computeStateFingerprint(orderOne)).toBe(computeStateFingerprint(orderTwo));
  });

  it("deterministically breaks ties when duplicate IDs have undefined file path or line number", () => {
    const findingNoPathA = {
      id: "dup-id",
      reviewerId: "coderabbitai",
      title: "Alpha no path",
      description: "Description",
      severity: "HIGH" as const,
      isBlocking: true,
      isResolved: false,
    };
    const findingNoPathB = {
      ...findingNoPathA,
      title: "Beta no path",
    };

    const orderOne = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [findingNoPathA, findingNoPathB],
        },
      },
    };
    const orderTwo = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [findingNoPathB, findingNoPathA],
        },
      },
    };

    expect(computeStateFingerprint(orderOne)).toBe(computeStateFingerprint(orderTwo));
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

  it("changes hash when finding acknowledgedCommitSha changes", () => {
    const modified = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [
            {
              ...findingOne,
              acknowledgedCommitSha: "3333333333333333333333333333333333333333",
            },
            findingTwo,
          ],
        },
      },
    };
    expect(computeStateFingerprint(modified)).not.toBe(computeStateFingerprint(baseInput));
  });

  it("changes hash when finding resolvedBy changes", () => {
    const modified = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [
            {
              ...findingOne,
              resolvedBy: "admin-reviewer",
            },
            findingTwo,
          ],
        },
      },
    };
    expect(computeStateFingerprint(modified)).not.toBe(computeStateFingerprint(baseInput));
  });

  it("changes hash when finding title or description changes", () => {
    const modifiedTitle = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [
            {
              ...findingOne,
              title: "Modified title",
            },
            findingTwo,
          ],
        },
      },
    };
    expect(computeStateFingerprint(modifiedTitle)).not.toBe(computeStateFingerprint(baseInput));

    const modifiedDescription = {
      ...baseInput,
      reviewers: {
        ...baseInput.reviewers,
        coderabbitai: {
          ...baseInput.reviewers.coderabbitai,
          findings: [
            {
              ...findingOne,
              description: "Modified description content",
            },
            findingTwo,
          ],
        },
      },
    };
    expect(computeStateFingerprint(modifiedDescription)).not.toBe(
      computeStateFingerprint(baseInput),
    );
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
