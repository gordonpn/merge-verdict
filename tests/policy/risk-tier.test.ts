import { describe, expect, it } from "vitest";
import { evaluateRiskTier, MergeVerdictConfigSchema } from "../../src/index.js";

const config = MergeVerdictConfigSchema.parse({
  approval: {
    risk: {
      low: { paths: ["docs/**", "**/*.md"], automated_approval: "allowed", effort: "lite" },
      high: {
        paths: [".github/workflows/**", "src/auth/**", "src/security/**"],
        automated_approval: "additional_review",
        require_human_review: true,
        effort: "max",
      },
    },
  },
});

describe("evaluateRiskTier", () => {
  it("allows pure low-risk paths including root Markdown files", () => {
    expect(evaluateRiskTier(["README.md", "docs/guide/setup.md"], config)).toEqual({
      tier: "low",
      matchedTiers: ["low"],
      automatedApproval: "allowed",
      requiresHumanReview: false,
      canAutoApprove: true,
      effort: "lite",
      usedFallback: false,
    });
  });

  it("requires human review and maximum effort for high-risk paths", () => {
    expect(evaluateRiskTier([".github/workflows/ci.yml"], config)).toMatchObject({
      tier: "high",
      canAutoApprove: false,
      requiresHumanReview: true,
      effort: "max",
      usedFallback: false,
    });
  });

  it("uses the strictest constraints for mixed changes regardless of path order", () => {
    const paths = ["README.md", ".github/workflows/ci.yml"];
    const result = evaluateRiskTier(paths, config);
    expect(result).toMatchObject({ tier: "high", matchedTiers: ["high", "low"], effort: "max" });
    expect(evaluateRiskTier([...paths].reverse(), config)).toEqual(result);
  });

  it("does not let a broad low-risk glob override an overlapping sensitive path", () => {
    expect(evaluateRiskTier(["src/auth/README.md"], config)).toMatchObject({
      tier: "high",
      matchedTiers: ["high", "low"],
      canAutoApprove: false,
    });
  });

  it.each([null, undefined, [], ["src/other.ts"], ["README.md", "src/other.ts"]])(
    "falls back to the strictest configured baseline for unavailable or unmatched paths: %j",
    (paths) => {
      expect(evaluateRiskTier(paths, config)).toMatchObject({
        tier: "high",
        canAutoApprove: false,
        requiresHumanReview: true,
        effort: "max",
        usedFallback: true,
      });
    },
  );

  it("defaults to a restrictive built-in baseline when no risk tiers exist", () => {
    expect(evaluateRiskTier(["README.md"], MergeVerdictConfigSchema.parse({}))).toEqual({
      tier: null,
      matchedTiers: [],
      automatedApproval: "disallowed",
      requiresHumanReview: true,
      canAutoApprove: false,
      effort: "max",
      usedFallback: true,
    });
  });

  it("does not approve unknown paths when only an allowlist is configured", () => {
    const allowlist = MergeVerdictConfigSchema.parse({
      approval: { risk: { low: { paths: ["docs/**"], effort: "lite" } } },
    });
    expect(evaluateRiskTier(["docs/readme.md"], allowlist).canAutoApprove).toBe(true);
    expect(evaluateRiskTier(["src/secret.ts"], allowlist)).toMatchObject({
      tier: null,
      automatedApproval: "disallowed",
      requiresHumanReview: true,
      effort: "max",
    });
  });

  it.each([
    "/docs/readme.md",
    "docs/../README.md",
    "./README.md",
    "docs//a.md",
    "docs\\a.md",
    "",
    "a\0.md",
  ])("fails closed for ambiguous repository paths: %j", (path) => {
    expect(evaluateRiskTier([path], config)).toMatchObject({
      canAutoApprove: false,
      usedFallback: true,
    });
  });

  it("requires explicit dotfile patterns under POSIX glob matching", () => {
    expect(evaluateRiskTier(["docs/.hidden.md"], config).usedFallback).toBe(true);
  });

  it("combines incomparable constraints without losing human review or effort", () => {
    const incomparable = MergeVerdictConfigSchema.parse({
      approval: {
        risk: {
          approval: { paths: ["src/**"], automated_approval: "disallowed", effort: "lite" },
          human: { paths: ["src/**"], require_human_review: true, effort: "balanced" },
          effort: { paths: ["src/**"], effort: "max" },
        },
      },
    });
    expect(evaluateRiskTier(["src/file.ts"], incomparable)).toMatchObject({
      automatedApproval: "disallowed",
      requiresHumanReview: true,
      effort: "max",
      canAutoApprove: false,
    });
    const reversed = structuredClone(incomparable);
    reversed.approval.risk = Object.fromEntries(Object.entries(reversed.approval.risk).reverse());
    expect(evaluateRiskTier(["src/file.ts"], reversed)).toEqual(
      evaluateRiskTier(["src/file.ts"], incomparable),
    );
  });

  it("withholds auto-approval for additional review even without a human-review flag", () => {
    const additional = MergeVerdictConfigSchema.parse({
      approval: { risk: { guarded: { paths: ["**"], automated_approval: "additional_review" } } },
    });
    expect(evaluateRiskTier(["file.ts"], additional)).toMatchObject({
      automatedApproval: "additional_review",
      requiresHumanReview: false,
      canAutoApprove: false,
      effort: "balanced",
    });
  });

  it("fails closed when malformed patterns leave a path unmatched", () => {
    const malformed = MergeVerdictConfigSchema.parse({
      approval: { risk: { low: { paths: ["["] } } },
    });
    expect(evaluateRiskTier(["README.md"], malformed)).toMatchObject({
      canAutoApprove: false,
      usedFallback: true,
    });
  });

  it("fails closed on glob engine errors even after a permissive pattern matches", () => {
    const invalid = MergeVerdictConfigSchema.parse({
      approval: { risk: { low: { paths: ["docs/**", "x".repeat(65537)] } } },
    });
    expect(evaluateRiskTier(["docs/a.md"], invalid)).toMatchObject({
      tier: null,
      automatedApproval: "disallowed",
      requiresHumanReview: true,
      effort: "max",
      usedFallback: true,
    });
  });

  it("does not mutate caller paths or configuration", () => {
    const paths = ["docs/a.md", "src/auth/token.ts"];
    const originalPaths = [...paths];
    const originalConfig = structuredClone(config);
    evaluateRiskTier(Object.freeze(paths), config);
    expect(paths).toEqual(originalPaths);
    expect(config).toEqual(originalConfig);
  });
});
