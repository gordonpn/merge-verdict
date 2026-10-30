import { z } from "zod";

/**
 * Valid finding severity levels in descending order of criticality.
 */
export const SEVERITIES = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "ADVISORY"] as const;

/**
 * Zod schema defining valid finding severity tiers.
 */
export const SeveritySchema = z.enum(SEVERITIES);

/**
 * Finding severity tier.
 */
export type Severity = z.infer<typeof SeveritySchema>;
