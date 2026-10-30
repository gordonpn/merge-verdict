import { z } from "zod";

/**
 * Valid check run execution states.
 */
export const CHECK_RUN_STATUSES = ["queued", "in_progress", "completed"] as const;

/**
 * Zod schema defining valid check run execution statuses.
 */
export const CheckRunStatusSchema = z.enum(CHECK_RUN_STATUSES);

/**
 * Check run execution status.
 */
export type CheckRunStatus = z.infer<typeof CheckRunStatusSchema>;

/**
 * Valid check run conclusions.
 */
export const CHECK_RUN_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "skipped",
] as const;

/**
 * Zod schema defining valid check run completion conclusions.
 */
export const CheckRunConclusionSchema = z.enum(CHECK_RUN_CONCLUSIONS);

/**
 * Check run completion conclusion.
 */
export type CheckRunConclusion = z.infer<typeof CheckRunConclusionSchema>;

/**
 * Zod schema validating a check run observation record.
 */
export const CheckRunRecordSchema = z.object({
  name: z.string().min(1),
  status: CheckRunStatusSchema,
  conclusion: CheckRunConclusionSchema.nullable(),
  commitSha: z.string().min(1),
  detailsUrl: z.string().url().optional(),
});

/**
 * Check run observation record.
 */
export type CheckRunRecord = z.infer<typeof CheckRunRecordSchema>;
