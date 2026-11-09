import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  createDefaultConfig,
  DEFAULT_CONFIG,
  loadConfigFile,
  loadConfigFileSync,
  MergeVerdictConfigSchema,
  normalizeConfigKeys,
  parseConfig,
  safeParseConfig,
} from "../../src/index.js";

describe("MergeVerdictConfigSchema", () => {
  it("supplies canonical defaults when given an empty object", () => {
    const config = MergeVerdictConfigSchema.parse({});
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("supplies canonical defaults when given null, undefined, or empty string", () => {
    expect(MergeVerdictConfigSchema.parse(null)).toEqual(DEFAULT_CONFIG);
    expect(MergeVerdictConfigSchema.parse(undefined)).toEqual(DEFAULT_CONFIG);
    expect(MergeVerdictConfigSchema.parse("")).toEqual(DEFAULT_CONFIG);
  });

  it("validates full camelCase configuration", () => {
    const input = {
      requiredReviewers: ["coderabbitai", "sourcery-ai"],
      requiredChecks: ["runner / test", "CodeQL"],
      allowAdvisoryExemptions: true,
      rateLimitTimeoutMinutes: 45,
      semanticVerification: {
        enabled: true,
        model: "deepseek-chat",
        maxTokensPerRun: 8000,
        endpoint: "https://api.deepseek.com/v1",
      },
      verification: {
        requireCurrentHeadSha: true as const,
        requireResolvedThreads: true as const,
        requireSuccessfulCi: true as const,
        requireCodeEvidence: false,
      },
      approval: {
        requiredCheck: "merge-verdict",
        providers: ["github_copilot", "github_app"] as const,
        requireVerifiedCommit: true as const,
        risk: {
          low: {
            paths: ["docs/**", "**/*.md"],
            automatedApproval: "allowed" as const,
            effort: "lite" as const,
          },
          high: {
            paths: [".github/workflows/**", "src/security/**"],
            automatedApproval: "additional_review" as const,
            requireHumanReview: true,
            effort: "max" as const,
          },
        },
      },
    };

    const config = MergeVerdictConfigSchema.parse(input);
    expect(config).toMatchObject({
      requiredReviewers: ["coderabbitai", "sourcery-ai"],
      requiredChecks: ["runner / test", "CodeQL"],
      allowAdvisoryExemptions: true,
      rateLimitTimeoutMinutes: 45,
      semanticVerification: {
        enabled: true,
        model: "deepseek-chat",
        maxTokensPerRun: 8000,
        endpoint: "https://api.deepseek.com/v1",
      },
      verification: {
        requireCurrentHeadSha: true,
        requireResolvedThreads: true,
        requireSuccessfulCi: true,
        requireCodeEvidence: false,
      },
      approval: {
        requiredCheck: "merge-verdict",
        providers: ["github_copilot", "github_app"],
        requireVerifiedCommit: true,
        risk: {
          low: {
            paths: ["docs/**", "**/*.md"],
            automatedApproval: "allowed",
            effort: "lite",
          },
          high: {
            paths: [".github/workflows/**", "src/security/**"],
            automatedApproval: "additional_review",
            requireHumanReview: true,
            effort: "max",
          },
        },
      },
    });
  });

  it("normalizes snake_case keys into canonical camelCase properties", () => {
    const snakeCaseInput = {
      required_reviewers: ["coderabbitai"],
      required_checks: ["runner / test"],
      allow_advisory_exemptions: true,
      rate_limit_timeout_minutes: 60,
      semantic_verification: {
        enabled: true,
        max_tokens_per_run: 2500,
      },
      verification: {
        require_code_evidence: false,
      },
      approval: {
        required_check: "merge-verdict-custom",
        providers: ["github_copilot"],
        risk: {
          low: {
            paths: ["docs/**"],
            automated_approval: "allowed",
            effort: "lite",
          },
          high: {
            paths: ["src/auth/**"],
            automated_approval: "additional_review",
            require_human_review: true,
            effort: "max",
          },
        },
      },
    };

    const config = MergeVerdictConfigSchema.parse(snakeCaseInput);
    expect(config.requiredReviewers).toEqual(["coderabbitai"]);
    expect(config.requiredChecks).toEqual(["runner / test"]);
    expect(config.allowAdvisoryExemptions).toBe(true);
    expect(config.rateLimitTimeoutMinutes).toBe(60);
    expect(config.semanticVerification.maxTokensPerRun).toBe(2500);
    expect(config.verification.requireCurrentHeadSha).toBe(true);
    expect(config.verification.requireCodeEvidence).toBe(false);
    expect(config.approval.requiredCheck).toBe("merge-verdict-custom");
    expect(config.approval.providers).toEqual(["github_copilot"]);
    expect(config.approval.risk.low?.automatedApproval).toBe("allowed");
    expect(config.approval.risk.high?.requireHumanReview).toBe(true);
  });

  it("supports boolean shorthand verification: true but rejects verification: false", () => {
    const trueConfig = MergeVerdictConfigSchema.parse({ verification: true });
    expect(trueConfig.verification).toEqual({
      requireCurrentHeadSha: true,
      requireResolvedThreads: true,
      requireSuccessfulCi: true,
      requireCodeEvidence: true,
    });

    expect(() => MergeVerdictConfigSchema.parse({ verification: false })).toThrow();
  });

  it("rejects disabling mandatory core verification gates", () => {
    expect(() =>
      MergeVerdictConfigSchema.parse({
        verification: { requireCurrentHeadSha: false },
      }),
    ).toThrow();
    expect(() =>
      MergeVerdictConfigSchema.parse({
        verification: { requireResolvedThreads: false },
      }),
    ).toThrow();
    expect(() =>
      MergeVerdictConfigSchema.parse({
        verification: { requireSuccessfulCi: false },
      }),
    ).toThrow();
  });

  it("accepts single string values for list fields and wraps them in arrays", () => {
    const config = MergeVerdictConfigSchema.parse({
      requiredReviewers: "sourcery-ai",
      requiredChecks: "build",
      approval: {
        providers: "github_app",
        risk: {
          low: {
            paths: "README.md",
          },
        },
      },
    });

    expect(config.requiredReviewers).toEqual(["sourcery-ai"]);
    expect(config.requiredChecks).toEqual(["build"]);
    expect(config.approval.providers).toEqual(["github_app"]);
    expect(config.approval.risk.low?.paths).toEqual(["README.md"]);
  });

  it("rejects non-positive rate limit timeout", () => {
    expect(() => MergeVerdictConfigSchema.parse({ rateLimitTimeoutMinutes: 0 })).toThrow();
    expect(() => MergeVerdictConfigSchema.parse({ rateLimitTimeoutMinutes: -10 })).toThrow();
    expect(() => MergeVerdictConfigSchema.parse({ rateLimitTimeoutMinutes: 2.5 })).toThrow();
  });

  it("rejects invalid approval provider options", () => {
    expect(() =>
      MergeVerdictConfigSchema.parse({
        approval: { providers: ["unsupported_provider"] },
      }),
    ).toThrow();
  });

  it("rejects invalid verification effort tiers", () => {
    expect(() =>
      MergeVerdictConfigSchema.parse({
        approval: {
          risk: {
            low: { effort: "unlimited" },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects invalid automated approval policy options", () => {
    expect(() =>
      MergeVerdictConfigSchema.parse({
        approval: {
          risk: {
            low: { automatedApproval: "unconditional" },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects empty or whitespace-only items in string lists", () => {
    expect(() => MergeVerdictConfigSchema.parse({ requiredReviewers: [""] })).toThrow();
    expect(() => MergeVerdictConfigSchema.parse({ requiredReviewers: ["   "] })).toThrow();
    expect(() => MergeVerdictConfigSchema.parse({ requiredChecks: ["   "] })).toThrow();
  });

  it("rejects unknown and misspelled properties due to strict object schemas", () => {
    expect(() => MergeVerdictConfigSchema.parse({ unknown_root_property: 123 })).toThrow();
    expect(() =>
      MergeVerdictConfigSchema.parse({
        approval: { unknownApprovalField: true },
      }),
    ).toThrow();
    expect(() =>
      MergeVerdictConfigSchema.parse({
        approval: {
          risk: {
            low: { typoProperty: "bad" },
          },
        },
      }),
    ).toThrow();
  });
});

describe("normalizeConfigKeys helper", () => {
  it("preserves custom risk-tier names while normalizing their inner properties", () => {
    const input = {
      approval: {
        risk: {
          security_sensitive: {
            paths: ["src/security/**"],
            automated_approval: "additional_review",
            require_human_review: true,
          },
          securitySensitive: {
            paths: ["src/auth/**"],
            effort: "max",
          },
        },
      },
    };

    const config = MergeVerdictConfigSchema.parse(input);
    expect(config.approval.risk.security_sensitive).toBeDefined();
    expect(config.approval.risk.securitySensitive).toBeDefined();
    expect(config.approval.risk.security_sensitive?.automatedApproval).toBe("additional_review");
    expect(config.approval.risk.security_sensitive?.requireHumanReview).toBe(true);
    expect(config.approval.risk.securitySensitive?.effort).toBe("max");
  });

  it("normalizes nested arrays and objects while preserving primitives", () => {
    const input = {
      foo_bar: 1,
      nested_obj: {
        baz_qux: [{ deep_key: "value" }, "primitive_string", 42],
      },
    };

    expect(normalizeConfigKeys(input)).toEqual({
      fooBar: 1,
      nestedObj: {
        bazQux: [{ deepKey: "value" }, "primitive_string", 42],
      },
    });
  });

  it("returns non-object primitives as-is", () => {
    expect(normalizeConfigKeys("hello")).toBe("hello");
    expect(normalizeConfigKeys(123)).toBe(123);
    expect(normalizeConfigKeys(null)).toBe(null);
  });

  it("throws when conflicting snake_case and camelCase keys have different values", () => {
    const conflicting = {
      rate_limit_timeout_minutes: 30,
      rateLimitTimeoutMinutes: 60,
    };
    expect(() => normalizeConfigKeys(conflicting)).toThrow(/Conflicting configuration keys/);
  });

  it("allows matching snake_case and camelCase keys when values are identical", () => {
    const matching = {
      rate_limit_timeout_minutes: 30,
      rateLimitTimeoutMinutes: 30,
    };
    expect(() => normalizeConfigKeys(matching)).not.toThrow();
  });

  it("throws when cyclic references are encountered", () => {
    const cyclicObj: Record<string, unknown> = { name: "cycle" };
    cyclicObj.self = cyclicObj;
    expect(() => normalizeConfigKeys(cyclicObj)).toThrow(/Cyclic reference detected/);
  });
});

describe("parseConfig", () => {
  it("parses valid YAML content", () => {
    const yaml = `
required_reviewers:
  - coderabbitai
  - sourcery-ai
required_checks:
  - runner / test
rate_limit_timeout_minutes: 40
`;
    const config = parseConfig(yaml);
    expect(config.requiredReviewers).toEqual(["coderabbitai", "sourcery-ai"]);
    expect(config.requiredChecks).toEqual(["runner / test"]);
    expect(config.rateLimitTimeoutMinutes).toBe(40);
  });

  it("parses valid JSON content", () => {
    const json = JSON.stringify({
      requiredReviewers: ["chatgpt-codex-connector"],
      rateLimitTimeoutMinutes: 20,
    });
    const config = parseConfig(json);
    expect(config.requiredReviewers).toEqual(["chatgpt-codex-connector"]);
    expect(config.rateLimitTimeoutMinutes).toBe(20);
  });

  it("returns DEFAULT_CONFIG for empty or whitespace content", () => {
    expect(parseConfig("")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("   \n\t  ")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("# comment only\n")).toEqual(DEFAULT_CONFIG);
  });

  it("returns independent configuration objects on default loads to prevent mutation leakage", () => {
    const config1 = parseConfig("");
    const config2 = parseConfig(null);

    // Mutate config1
    (config1.requiredReviewers as string[]).push("mutated-reviewer");
    config1.rateLimitTimeoutMinutes = 999;

    // Verify config2 and DEFAULT_CONFIG remain unaffected
    expect(config2.requiredReviewers).toEqual([]);
    expect(config2.rateLimitTimeoutMinutes).toBe(30);
    expect(DEFAULT_CONFIG.requiredReviewers).toEqual([]);
    expect(DEFAULT_CONFIG.rateLimitTimeoutMinutes).toBe(30);

    const freshDefault = createDefaultConfig();
    expect(freshDefault.requiredReviewers).toEqual([]);
    expect(freshDefault.rateLimitTimeoutMinutes).toBe(30);
  });

  it("throws ConfigValidationError on YAML syntax error", () => {
    const malformedYaml = "foo: [unclosed sequence";
    expect(() => parseConfig(malformedYaml)).toThrow(ConfigValidationError);
    expect(() => parseConfig(malformedYaml)).toThrow(/YAML syntax error/);

    try {
      parseConfig(malformedYaml);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const configError = error as ConfigValidationError;
      expect(configError.issues).toHaveLength(1);
      expect(configError.issues[0]?.code).toBe("syntax_error");
    }
  });

  it("throws ConfigValidationError when YAML parses to non-object primitives or arrays", () => {
    expect(() => parseConfig("just a scalar string")).toThrow(ConfigValidationError);
    expect(() => parseConfig("42")).toThrow(ConfigValidationError);
    expect(() => parseConfig("- item 1\n- item 2")).toThrow(ConfigValidationError);
  });

  it("throws ConfigValidationError with formatted diagnostics on schema violation", () => {
    const invalidYaml = `
rate_limit_timeout_minutes: "not-a-number"
approval:
  providers:
    - unsupported_bot
`;
    expect(() => parseConfig(invalidYaml)).toThrow(ConfigValidationError);

    try {
      parseConfig(invalidYaml);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const configError = error as ConfigValidationError;
      expect(configError.issues.length).toBeGreaterThanOrEqual(2);
      expect(configError.message).toContain("Configuration validation failed");
      expect(configError.message).toContain("rateLimitTimeoutMinutes");
      expect(configError.message).toContain("approval.providers");
    }
  });
});

describe("safeParseConfig", () => {
  it("returns success with config for valid content", () => {
    const result = safeParseConfig("required_reviewers:\n  - coderabbitai");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config.requiredReviewers).toEqual(["coderabbitai"]);
    }
  });

  it("returns success with DEFAULT_CONFIG for empty input", () => {
    const result = safeParseConfig("");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config).toEqual(DEFAULT_CONFIG);
    }
  });

  it("returns failure with ConfigValidationError for invalid input without throwing", () => {
    const result = safeParseConfig("rate_limit_timeout_minutes: -5");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ConfigValidationError);
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("handles empty issues array on ConfigValidationError gracefully", () => {
    const error = new ConfigValidationError("custom error message");
    expect(error.issues).toEqual([]);
    expect(error.message).toBe("custom error message");
  });
});

describe("loadConfigFile and loadConfigFileSync", () => {
  const testDir = join(process.cwd(), "tests", "fixtures", "temp-config-test");
  const testValidFile = join(testDir, "valid-merge-verdict.yml");
  const testInvalidFile = join(testDir, "invalid-merge-verdict.yml");
  const testNonExistentFile = join(testDir, "does-not-exist.yml");

  beforeAll(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      testValidFile,
      `
verification:
  require_current_head_sha: true
approval:
  providers:
    - github_copilot
`,
      "utf8",
    );
    writeFileSync(
      testInvalidFile,
      `
rate_limit_timeout_minutes: -10
`,
      "utf8",
    );
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loadConfigFile loads and parses an existing file", async () => {
    const config = await loadConfigFile(testValidFile);
    expect(config.approval.providers).toEqual(["github_copilot"]);
    expect(config.verification.requireCurrentHeadSha).toBe(true);
  });

  it("loadConfigFile returns DEFAULT_CONFIG when the file is absent", async () => {
    const config = await loadConfigFile(testNonExistentFile);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("loadConfigFile throws ConfigValidationError when file content is invalid", async () => {
    await expect(loadConfigFile(testInvalidFile)).rejects.toThrow(ConfigValidationError);
  });

  it("loadConfigFile propagates non-ENOENT filesystem errors", async () => {
    await expect(loadConfigFile(testDir)).rejects.toThrow();
  });

  it("loadConfigFileSync loads and parses an existing file synchronously", () => {
    const config = loadConfigFileSync(testValidFile);
    expect(config.approval.providers).toEqual(["github_copilot"]);
    expect(config.verification.requireCurrentHeadSha).toBe(true);
  });

  it("loadConfigFileSync returns DEFAULT_CONFIG when the file is absent", () => {
    const config = loadConfigFileSync(testNonExistentFile);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("loadConfigFileSync throws ConfigValidationError when file content is invalid", () => {
    expect(() => loadConfigFileSync(testInvalidFile)).toThrow(ConfigValidationError);
  });

  it("loadConfigFileSync propagates non-ENOENT filesystem errors", () => {
    expect(() => loadConfigFileSync(testDir)).toThrow();
  });
});
