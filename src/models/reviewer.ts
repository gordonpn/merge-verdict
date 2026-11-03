import { z } from "zod";
import { NormalizedFindingSchema } from "./finding.js";

/**
 * Valid reviewer execution states.
 */
export const REVIEWER_STATUSES = [
  "PENDING",
  "COMPLETED",
  "STALE",
  "RATE_LIMITED",
  "FAILED",
  "SKIPPED",
  "EXEMPT",
] as const;

/**
 * Zod schema defining valid reviewer execution statuses.
 */
export const ReviewerStatusSchema = z.enum(REVIEWER_STATUSES);

/**
 * Reviewer execution status.
 */
export type ReviewerStatus = z.infer<typeof ReviewerStatusSchema>;

/**
 * Valid reviewer verdict decisions.
 */
export const REVIEWER_VERDICTS = ["APPROVE", "CHANGES_REQUESTED", "COMMENTED", "NONE"] as const;

/**
 * Zod schema defining valid reviewer verdict decisions.
 */
export const ReviewerVerdictSchema = z.enum(REVIEWER_VERDICTS);

/**
 * Reviewer verdict decision.
 */
export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

/**
 * Zod schema validating a reviewer execution record.
 */
export const ReviewerExecutionRecordSchema = z.object({
  reviewerId: z.string().min(1),
  reviewerName: z.string().min(1),
  status: ReviewerStatusSchema,
  evaluatedCommitSha: z.string().nullable(),
  isFresh: z.boolean(),
  verdict: ReviewerVerdictSchema,
  summary: z.string().optional(),
  findings: z.array(NormalizedFindingSchema),
  checkRunConclusion: z.string().nullable(),
});

/**
 * Reviewer execution record.
 */
export type ReviewerExecutionRecord = z.infer<typeof ReviewerExecutionRecordSchema>;
