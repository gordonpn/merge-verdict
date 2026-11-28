import { z } from "zod";
import { SeveritySchema } from "./severity.js";

/**
 * Zod schema validating a normalized reviewer finding.
 */
export const NormalizedFindingSchema = z
  .object({
    id: z.string().min(1),
    reviewerId: z.string().min(1),
    threadId: z.string().optional(),
    title: z.string().min(1),
    description: z.string(),
    filePath: z.string().optional(),
    startLineNumber: z.number().int().positive().optional(),
    lineNumber: z.number().int().positive().optional(),
    severity: SeveritySchema,
    isBlocking: z.boolean(),
    isResolved: z.boolean(),
    resolvedBy: z.string().optional(),
    acknowledgedCommitSha: z.string().optional(),
    rawCommentUrl: z.string().url().optional(),
  })
  .refine(
    (finding) =>
      finding.startLineNumber === undefined ||
      (finding.lineNumber !== undefined && finding.startLineNumber <= finding.lineNumber),
    {
      message: "startLineNumber requires lineNumber and must be less than or equal to lineNumber",
      path: ["startLineNumber"],
    },
  );

/**
 * Normalized reviewer finding.
 */
export type NormalizedFinding = z.infer<typeof NormalizedFindingSchema>;
