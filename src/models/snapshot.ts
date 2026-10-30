import { createHash } from "node:crypto";
import { z } from "zod";
import { CheckRunRecordSchema } from "./check-run.js";
import { ReviewerExecutionRecordSchema } from "./reviewer.js";

/**
 * Zod schema validating an immutable pull request review snapshot.
 */
export const ReviewSnapshotSchema = z.object({
  repository: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  baseSha: z.string().min(1),
  isDraft: z.boolean(),
  stateFingerprint: z.string().min(1),
  reviewers: z.record(z.string(), ReviewerExecutionRecordSchema),
  unresolvedThreadCount: z.number().int().nonnegative(),
  blockingDecisionCount: z.number().int().nonnegative(),
  checkRuns: z.record(z.string(), CheckRunRecordSchema),
  capturedAt: z.string().datetime(),
});

/**
 * Immutable pull request review snapshot.
 */
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;

/**
 * Input fields required to compute a deterministic state fingerprint.
 */
export interface StateFingerprintInput {
  readonly headSha: string;
  readonly unresolvedThreadCount: number;
  readonly blockingDecisionCount: number;
  readonly reviewers: Readonly<Record<string, z.infer<typeof ReviewerExecutionRecordSchema>>>;
  readonly checkRuns: Readonly<Record<string, z.infer<typeof CheckRunRecordSchema>>>;
}

/**
 * Computes a deterministic SHA-256 fingerprint from snapshot state components.
 *
 * @param input State snapshot data fields.
 * @returns 64-character lowercase hexadecimal SHA-256 hash string.
 */
export function computeStateFingerprint(input: StateFingerprintInput): string {
  const sortedReviewerEntries = Object.entries(input.reviewers).sort(([keyA], [keyB]) =>
    keyA.localeCompare(keyB),
  );

  const normalizedReviewers = sortedReviewerEntries.map(([, rev]) => {
    const sortedFindings = [...rev.findings]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        isBlocking: finding.isBlocking,
        isResolved: finding.isResolved,
        threadId: finding.threadId ?? null,
        filePath: finding.filePath ?? null,
        lineNumber: finding.lineNumber ?? null,
      }));

    return {
      reviewerId: rev.reviewerId,
      status: rev.status,
      evaluatedCommitSha: rev.evaluatedCommitSha,
      isFresh: rev.isFresh,
      verdict: rev.verdict,
      checkRunConclusion: rev.checkRunConclusion,
      findings: sortedFindings,
    };
  });

  const sortedCheckRunEntries = Object.entries(input.checkRuns).sort(([keyA], [keyB]) =>
    keyA.localeCompare(keyB),
  );

  const normalizedCheckRuns = sortedCheckRunEntries.map(([, run]) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    commitSha: run.commitSha,
  }));

  const canonicalPayload = JSON.stringify({
    headSha: input.headSha,
    unresolvedThreadCount: input.unresolvedThreadCount,
    blockingDecisionCount: input.blockingDecisionCount,
    reviewers: normalizedReviewers,
    checkRuns: normalizedCheckRuns,
  });

  return createHash("sha256").update(canonicalPayload).digest("hex");
}

/**
 * Input fields for creating a validated review snapshot.
 */
export type CreateReviewSnapshotInput = Omit<ReviewSnapshot, "stateFingerprint" | "capturedAt"> & {
  readonly stateFingerprint?: string;
  readonly capturedAt?: string;
};

/**
 * Constructs and validates a complete ReviewSnapshot with computed fingerprint.
 *
 * @param input Snapshot values with optional stateFingerprint and capturedAt.
 * @returns Fully validated ReviewSnapshot object.
 * @throws {z.ZodError} If any field violates ReviewSnapshotSchema constraints.
 */
export function createReviewSnapshot(input: CreateReviewSnapshotInput): ReviewSnapshot {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const stateFingerprint =
    input.stateFingerprint ??
    computeStateFingerprint({
      headSha: input.headSha,
      unresolvedThreadCount: input.unresolvedThreadCount,
      blockingDecisionCount: input.blockingDecisionCount,
      reviewers: input.reviewers,
      checkRuns: input.checkRuns,
    });

  return ReviewSnapshotSchema.parse({
    ...input,
    capturedAt,
    stateFingerprint,
  });
}
