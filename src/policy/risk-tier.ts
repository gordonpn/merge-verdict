import { posix } from "node:path";
import type {
  AutomatedApprovalPolicy,
  MergeVerdictConfig,
  RiskTierConfig,
  VerificationEffort,
} from "../models/config.js";

/** Effective constraints for all changed paths, independent of approval providers. */
export interface RiskTierEvaluation {
  /** Representative strictest tier; null denotes the built-in restrictive baseline. */
  tier: string | null;
  matchedTiers: string[];
  automatedApproval: AutomatedApprovalPolicy;
  requiresHumanReview: boolean;
  canAutoApprove: boolean;
  effort: VerificationEffort;
  usedFallback: boolean;
}

const APPROVAL_RANK = { allowed: 0, additional_review: 1, disallowed: 2 } as const;
const EFFORT_RANK = { lite: 0, balanced: 1, max: 2 } as const;
const BASELINE: RiskTierConfig = {
  paths: [],
  automatedApproval: "disallowed",
  requireHumanReview: true,
  effort: "max",
};

type NamedTier = readonly [name: string, config: RiskTierConfig];

function compareTiers(left: NamedTier, right: NamedTier): number {
  return (
    APPROVAL_RANK[right[1].automatedApproval] - APPROVAL_RANK[left[1].automatedApproval] ||
    Number(right[1].requireHumanReview) - Number(left[1].requireHumanReview) ||
    EFFORT_RANK[right[1].effort] - EFFORT_RANK[left[1].effort] ||
    (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
  );
}

/** GitHub paths are unambiguous, relative POSIX paths, never normalized user input. */
function isRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !posix.isAbsolute(path) &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/**
 * Resolves path risk from already validated, trusted base-branch configuration.
 *
 * Overlapping tiers combine the most restrictive approval policy, human-review
 * requirement, and effort independently, so incomparable tiers cannot weaken one
 * another. Unmatched or unavailable paths use all configured tiers as a baseline.
 * If that baseline permits automatic approval, a built-in disallow/human/max
 * baseline prevents an incomplete allowlist from approving unknown changes.
 *
 * Matching uses Node's POSIX glob semantics, including globstars and explicit
 * dotfile patterns. Paths with dot segments or backslashes fail closed.
 */
export function evaluateRiskTier(
  changedFilePaths: readonly string[] | null | undefined,
  config: MergeVerdictConfig,
): RiskTierEvaluation {
  const tiers = Object.entries(config.approval.risk).sort(compareTiers);
  const matched = new Map<string, RiskTierConfig>();
  let usedFallback = !changedFilePaths?.length;

  for (const path of changedFilePaths ?? []) {
    let pathTiers: NamedTier[] = [];
    if (isRepositoryPath(path)) {
      try {
        // Evaluate every pattern so an invalid restrictive pattern cannot be
        // hidden by an earlier permissive match.
        pathTiers = tiers.filter(([, tier]) =>
          tier.paths.map((pattern) => posix.matchesGlob(path, pattern)).some(Boolean),
        );
      } catch {
        return {
          tier: null,
          matchedTiers: [],
          automatedApproval: BASELINE.automatedApproval,
          requiresHumanReview: BASELINE.requireHumanReview,
          canAutoApprove: false,
          effort: BASELINE.effort,
          usedFallback: true,
        };
      }
    }
    if (pathTiers.length === 0) {
      usedFallback = true;
    }
    for (const [name, tier] of pathTiers) {
      matched.set(name, tier);
    }
  }

  const selected: NamedTier[] = usedFallback ? tiers : [...matched.entries()].sort(compareTiers);
  let automatedApproval: AutomatedApprovalPolicy = "allowed";
  let requiresHumanReview = false;
  let effort: VerificationEffort = "lite";
  for (const [, tier] of selected) {
    if (APPROVAL_RANK[tier.automatedApproval] > APPROVAL_RANK[automatedApproval]) {
      automatedApproval = tier.automatedApproval;
    }
    requiresHumanReview ||= tier.requireHumanReview;
    if (EFFORT_RANK[tier.effort] > EFFORT_RANK[effort]) {
      effort = tier.effort;
    }
  }

  const needsBuiltInBaseline =
    selected.length === 0 ||
    (usedFallback && automatedApproval === "allowed" && !requiresHumanReview);
  if (needsBuiltInBaseline) {
    automatedApproval = BASELINE.automatedApproval;
    requiresHumanReview = BASELINE.requireHumanReview;
    effort = BASELINE.effort;
  }

  return {
    tier: needsBuiltInBaseline ? null : (selected[0]?.[0] ?? null),
    matchedTiers: [...matched.keys()].sort(),
    automatedApproval,
    requiresHumanReview,
    canAutoApprove: automatedApproval === "allowed" && !requiresHumanReview,
    effort,
    usedFallback,
  };
}
