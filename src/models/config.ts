import { z } from "zod";

/**
 * Valid approval provider identifiers.
 */
export const APPROVAL_PROVIDERS = ["github_copilot", "github_app", "none"] as const;

/**
 * Zod schema defining valid approval provider identifiers.
 */
export const ApprovalProviderSchema = z.enum(APPROVAL_PROVIDERS);

/**
 * Supported approval provider type.
 */
export type ApprovalProviderType = z.infer<typeof ApprovalProviderSchema>;

/**
 * Valid verification effort tiers.
 */
export const VERIFICATION_EFFORTS = ["lite", "balanced", "max"] as const;

/**
 * Zod schema defining valid verification effort tiers.
 */
export const VerificationEffortSchema = z.enum(VERIFICATION_EFFORTS);

/**
 * Verification effort tier.
 */
export type VerificationEffort = z.infer<typeof VerificationEffortSchema>;

/**
 * Valid automated approval policy options for path risk tiers.
 */
export const AUTOMATED_APPROVAL_POLICIES = ["allowed", "disallowed", "additional_review"] as const;

/**
 * Zod schema defining automated approval policies.
 */
export const AutomatedApprovalPolicySchema = z.enum(AUTOMATED_APPROVAL_POLICIES);

/**
 * Automated approval policy option.
 */
export type AutomatedApprovalPolicy = z.infer<typeof AutomatedApprovalPolicySchema>;

/**
 * Converts a snake_case string into camelCase.
 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

/**
 * Recursively converts object keys from snake_case to camelCase.
 */
export function normalizeConfigKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeConfigKeys);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[snakeToCamel(key)] = normalizeConfigKeys(val);
    }
    return result;
  }
  return value;
}

/**
 * Zod schema validating semantic LLM escalation settings.
 */
export const SemanticVerificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().min(1).optional(),
  maxTokensPerRun: z.number().int().positive().default(4000),
  endpoint: z.string().min(1).optional(),
});

/**
 * Semantic LLM escalation configuration settings.
 */
export type SemanticVerificationConfig = z.infer<typeof SemanticVerificationConfigSchema>;

/**
 * Base Zod schema validating verification rule flags.
 */
const BaseVerificationRulesConfigSchema = z.object({
  requireCurrentHeadSha: z.boolean().default(true),
  requireResolvedThreads: z.boolean().default(true),
  requireSuccessfulCi: z.boolean().default(true),
  requireCodeEvidence: z.boolean().default(true),
});

/**
 * Zod schema validating verification rules with boolean shorthand support.
 */
export const VerificationRulesConfigSchema = z
  .union([z.boolean(), BaseVerificationRulesConfigSchema])
  .transform((val) => {
    if (typeof val === "boolean") {
      return {
        requireCurrentHeadSha: val,
        requireResolvedThreads: val,
        requireSuccessfulCi: val,
        requireCodeEvidence: val,
      };
    }
    return val;
  });

/**
 * Verification rule flags.
 */
export type VerificationRulesConfig = z.infer<typeof BaseVerificationRulesConfigSchema>;

/**
 * Helper schema accepting either a single string or array of strings.
 */
const StringListSchema = z
  .union([
    z
      .string()
      .min(1)
      .transform((item) => [item]),
    z.array(z.string().min(1)),
  ])
  .default([]);

/**
 * Helper schema accepting either a single approval provider or array of providers.
 */
const ProvidersListSchema = z
  .union([
    ApprovalProviderSchema.transform((provider) => [provider]),
    z.array(ApprovalProviderSchema),
  ])
  .default(["none"]);

/**
 * Zod schema validating path-scoped risk tier definitions.
 */
export const RiskTierConfigSchema = z.object({
  paths: z.union([z.string().transform((path) => [path]), z.array(z.string())]).default([]),
  automatedApproval: AutomatedApprovalPolicySchema.default("allowed"),
  requireHumanReview: z.boolean().default(false),
  effort: VerificationEffortSchema.default("balanced"),
});

/**
 * Path-scoped risk tier configuration.
 */
export type RiskTierConfig = z.infer<typeof RiskTierConfigSchema>;

/**
 * Zod schema validating the approval section of the policy configuration.
 */
export const ApprovalConfigSchema = z.object({
  requiredCheck: z.string().min(1).default("merge-verdict"),
  providers: ProvidersListSchema,
  requireVerifiedCommit: z.boolean().default(true),
  risk: z.record(z.string(), RiskTierConfigSchema).default({}),
});

/**
 * Approval and status check configuration settings.
 */
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

/**
 * Internal object schema defining the canonical shape of repository configuration.
 */
const CanonicalMergeVerdictConfigSchema = z.object({
  requiredReviewers: StringListSchema,
  requiredChecks: StringListSchema,
  allowAdvisoryExemptions: z.boolean().default(false),
  rateLimitTimeoutMinutes: z.number().int().positive().default(30),
  semanticVerification: SemanticVerificationConfigSchema.default({
    enabled: false,
    maxTokensPerRun: 4000,
  }),
  verification: VerificationRulesConfigSchema.default({
    requireCurrentHeadSha: true,
    requireResolvedThreads: true,
    requireSuccessfulCi: true,
    requireCodeEvidence: true,
  }),
  approval: ApprovalConfigSchema.default({
    requiredCheck: "merge-verdict",
    providers: ["none"],
    requireVerifiedCommit: true,
    risk: {},
  }),
});

/**
 * Zod schema validating repository verification policy configuration (.github/merge-verdict.yml).
 */
export const MergeVerdictConfigSchema = z.preprocess((input) => {
  if (input === null || input === undefined || input === "") {
    return {};
  }
  return normalizeConfigKeys(input);
}, CanonicalMergeVerdictConfigSchema);

/**
 * Strongly typed repository verification policy configuration.
 */
export type MergeVerdictConfig = z.infer<typeof CanonicalMergeVerdictConfigSchema>;

/**
 * Canonical default configuration applied when no configuration file is present.
 */
export const DEFAULT_CONFIG: MergeVerdictConfig = {
  requiredReviewers: [],
  requiredChecks: [],
  allowAdvisoryExemptions: false,
  rateLimitTimeoutMinutes: 30,
  semanticVerification: {
    enabled: false,
    maxTokensPerRun: 4000,
  },
  verification: {
    requireCurrentHeadSha: true,
    requireResolvedThreads: true,
    requireSuccessfulCi: true,
    requireCodeEvidence: true,
  },
  approval: {
    requiredCheck: "merge-verdict",
    providers: ["none"],
    requireVerifiedCommit: true,
    risk: {},
  },
};
