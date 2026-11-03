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

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Computes a deterministic SHA-256 fingerprint from snapshot state components.
 *
 * @param input State snapshot data fields.
 * @returns 64-character lowercase hexadecimal SHA-256 hash string.
 */
export function computeStateFingerprint(input: StateFingerprintInput): string {
  const sortedReviewerEntries = Object.entries(input.reviewers).sort(([keyA], [keyB]) =>
    compareCodeUnits(keyA, keyB),
  );

  const normalizedReviewers = sortedReviewerEntries.map(([, rev]) => {
    const sortedFindings = [...rev.findings]
      .sort((a, b) => {
        const idComparison = compareCodeUnits(a.id, b.id);
        if (idComparison !== 0) {
          return idComparison;
        }
        const pathComparison = compareCodeUnits(a.filePath ?? "", b.filePath ?? "");
        if (pathComparison !== 0) {
          return pathComparison;
        }
        const lineComparison = (a.lineNumber ?? 0) - (b.lineNumber ?? 0);
        if (lineComparison !== 0) {
          return lineComparison;
        }
        return compareCodeUnits(a.title, b.title);
      })
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        isBlocking: finding.isBlocking,
        isResolved: finding.isResolved,
        resolvedBy: finding.resolvedBy ?? null,
        acknowledgedCommitSha: finding.acknowledgedCommitSha ?? null,
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
    compareCodeUnits(keyA, keyB),
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

const CreateReviewSnapshotInputSchema = ReviewSnapshotSchema.omit({
  stateFingerprint: true,
  capturedAt: true,
}).extend({
  stateFingerprint: z.string().min(1).optional(),
  capturedAt: z.string().datetime().optional(),
});

/**
 * Constructs and validates a complete ReviewSnapshot with computed fingerprint.
 *
 * @param input Snapshot values with optional stateFingerprint and capturedAt.
 * @returns Fully validated ReviewSnapshot object.
 * @throws {z.ZodError} If any field violates ReviewSnapshotSchema constraints.
 */
export function createReviewSnapshot(input: CreateReviewSnapshotInput): ReviewSnapshot {
  const validatedInput = CreateReviewSnapshotInputSchema.parse(input);
  const capturedAt = validatedInput.capturedAt ?? new Date().toISOString();
  const stateFingerprint =
    validatedInput.stateFingerprint ??
    computeStateFingerprint({
      headSha: validatedInput.headSha,
      unresolvedThreadCount: validatedInput.unresolvedThreadCount,
      blockingDecisionCount: validatedInput.blockingDecisionCount,
      reviewers: validatedInput.reviewers,
      checkRuns: validatedInput.checkRuns,
    });

  return ReviewSnapshotSchema.parse({
    ...validatedInput,
    capturedAt,
    stateFingerprint,
  });
}
