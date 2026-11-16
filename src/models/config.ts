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
 * Recursively converts object property keys from snake_case to camelCase,
 * while preserving user-defined risk-tier and check-name record keys.
 */
export function normalizeConfigKeys(
  value: unknown,
  path: readonly string[] = [],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      throw new Error("Cyclic reference detected in configuration payload.");
    }
    seen.add(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeConfigKeys(item, path, seen));
  }
  if (value !== null && typeof value === "object") {
    const preserveKeys =
      (path.length === 2 && path[0] === "approval" && path[1] === "risk") ||
      (path.length === 1 && path[0] === "permittedCheckConclusions");
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, val] of Object.entries(value)) {
      const outKey = preserveKeys ? key : snakeToCamel(key);
      if (!preserveKeys && key !== outKey && Object.hasOwn(value, outKey)) {
        const existingVal = (value as Record<string, unknown>)[outKey];
        if (JSON.stringify(existingVal) !== JSON.stringify(val)) {
          throw new Error(
            `Conflicting configuration keys specified: "${key}" and "${outKey}" have different values.`,
          );
        }
      }
      result[outKey] = normalizeConfigKeys(val, [...path, outKey], seen);
    }
    return result;
  }
  return value;
}

/**
 * Zod schema validating semantic LLM escalation settings.
 */
export const SemanticVerificationConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  model: z.string().trim().min(1).optional(),
  maxTokensPerRun: z.number().int().positive().default(4000),
  endpoint: z.string().trim().min(1).optional(),
});

/**
 * Semantic LLM escalation configuration settings.
 */
export type SemanticVerificationConfig = z.infer<typeof SemanticVerificationConfigSchema>;

/**
 * Base Zod schema validating verification rule flags.
 */
const BaseVerificationRulesConfigSchema = z.strictObject({
  requireCurrentHeadSha: z.literal(true).default(true),
  requireResolvedThreads: z.literal(true).default(true),
  requireSuccessfulCi: z.literal(true).default(true),
  requireCodeEvidence: z.boolean().default(true),
});

/**
 * Zod schema validating verification rules with boolean shorthand support.
 */
export const VerificationRulesConfigSchema = z.union([
  z.literal(true).transform(() => ({
    requireCurrentHeadSha: true as const,
    requireResolvedThreads: true as const,
    requireSuccessfulCi: true as const,
    requireCodeEvidence: true,
  })),
  BaseVerificationRulesConfigSchema,
]);

/**
 * Verification rule flags.
 */
export type VerificationRulesConfig = z.infer<typeof BaseVerificationRulesConfigSchema>;

/**
 * Helper schema accepting either a single string or array of non-empty strings.
 */
const StringListSchema = z
  .union([
    z
      .string()
      .trim()
      .min(1)
      .transform((item) => [item]),
    z.array(z.string().trim().min(1)),
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
export const RiskTierConfigSchema = z.strictObject({
  paths: z
    .union([
      z
        .string()
        .trim()
        .min(1)
        .transform((path) => [path]),
      z.array(z.string().trim().min(1)),
    ])
    .default([]),
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
export const ApprovalConfigSchema = z.strictObject({
  requiredCheck: z.string().trim().min(1).default("merge-verdict"),
  providers: ProvidersListSchema,
  requireVerifiedCommit: z.literal(true).default(true),
  risk: z.record(z.string(), RiskTierConfigSchema).default({}),
});

/**
 * Approval and status check configuration settings.
 */
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

/**
 * Validates check permissions while retaining all own check names, including __proto__.
 * Zod's record output omits __proto__, so preserve the validated input entries.
 */
const PermittedCheckConclusionsSchema = z.unknown().transform((input, context) => {
  const valueSchema = z.array(z.enum(["neutral", "skipped"]));
  const result = z.record(z.string(), valueSchema).safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ ...issue });
    return z.NEVER;
  }
  const entries: [string, ("neutral" | "skipped")[]][] = [];
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    const parsed = valueSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ ...issue, path: [name, ...issue.path] });
      }
      return z.NEVER;
    }
    entries.push([name, parsed.data]);
  }
  return Object.fromEntries(entries);
});

/**
 * Internal object schema defining the canonical shape of repository configuration.
 */
const CanonicalMergeVerdictConfigSchema = z.strictObject({
  requiredReviewers: StringListSchema,
  requiredChecks: StringListSchema,
  blockingSeverityThreshold: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  permittedCheckConclusions: PermittedCheckConclusionsSchema.optional(),
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

/**
 * Returns an independent, deep-cloned copy of the default repository configuration.
 *
 * @returns Fresh MergeVerdictConfig object.
 */
export function createDefaultConfig(): MergeVerdictConfig {
  return structuredClone(DEFAULT_CONFIG);
}
