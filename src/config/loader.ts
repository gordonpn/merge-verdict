import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  createDefaultConfig,
  type MergeVerdictConfig,
  MergeVerdictConfigSchema,
} from "../models/config.js";

/**
 * Diagnostic record describing a single configuration validation failure.
 */
export interface ConfigValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/**
 * Error raised when repository configuration fails syntax or schema validation.
 */
export class ConfigValidationError extends Error {
  public readonly issues: readonly ConfigValidationIssue[];

  constructor(message: string, issues: readonly ConfigValidationIssue[] = []) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Successful result of configuration parsing.
 */
export interface ConfigParseSuccess {
  readonly success: true;
  readonly config: MergeVerdictConfig;
}

/**
 * Failed result of configuration parsing.
 */
export interface ConfigParseFailure {
  readonly success: false;
  readonly error: ConfigValidationError;
}

/**
 * Result of safe configuration parsing.
 */
export type ConfigParseResult = ConfigParseSuccess | ConfigParseFailure;

/**
 * Formats a list of validation issues into a human-readable diagnostic error message.
 */
function formatValidationErrorMessage(issues: readonly ConfigValidationIssue[]): string {
  const bulletPoints = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
  return `Configuration validation failed with ${issues.length} error(s):\n${bulletPoints}`;
}

/**
 * Default relative path to the repository verification policy file.
 */
export const DEFAULT_CONFIG_FILE_PATH = ".github/merge-verdict.yml";

/**
 * Parses raw YAML or JSON string content into a validated MergeVerdictConfig.
 *
 * @param content Raw YAML or JSON configuration text.
 * @returns Strongly typed, validated MergeVerdictConfig.
 * @throws ConfigValidationError if parsing fails or payload violates the schema.
 */
export function parseConfig(content?: string | null): MergeVerdictConfig {
  if (content === null || content === undefined || content.trim() === "") {
    return createDefaultConfig();
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(`YAML syntax error: ${message}`, [
      { path: "", message, code: "syntax_error" },
    ]);
  }

  if (parsed === null || parsed === undefined) {
    return createDefaultConfig();
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigValidationError("Configuration root must be an object.", [
      {
        path: "",
        message: "Configuration root must be an object.",
        code: "invalid_type",
      },
    ]);
  }

  const result = MergeVerdictConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues: ConfigValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    }));
    throw new ConfigValidationError(formatValidationErrorMessage(issues), issues);
  }

  return result.data;
}

/**
 * Safely parses raw YAML or JSON string content without throwing exceptions.
 *
 * @param content Raw YAML or JSON configuration text.
 * @returns ConfigParseResult indicating success with config or failure with error.
 */
export function safeParseConfig(content?: string | null): ConfigParseResult {
  try {
    const config = parseConfig(content);
    return { success: true, config };
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return { success: false, error };
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Asynchronously loads and parses configuration from a file on disk.
 *
 * @param filePath Path to configuration file. Defaults to .github/merge-verdict.yml.
 * @returns Parsed MergeVerdictConfig, or DEFAULT_CONFIG if the file does not exist.
 * @throws ConfigValidationError if the file exists but contains invalid configuration.
 */
export async function loadConfigFile(
  filePath: string = DEFAULT_CONFIG_FILE_PATH,
): Promise<MergeVerdictConfig> {
  try {
    const content = await readFile(filePath, "utf8");
    return parseConfig(content);
  } catch (error) {
    if (isEnoent(error)) {
      return createDefaultConfig();
    }
    throw error;
  }
}

/**
 * Synchronously loads and parses configuration from a file on disk.
 *
 * @param filePath Path to configuration file. Defaults to .github/merge-verdict.yml.
 * @returns Parsed MergeVerdictConfig, or DEFAULT_CONFIG if the file does not exist.
 * @throws ConfigValidationError if the file exists but contains invalid configuration.
 */
export function loadConfigFileSync(
  filePath: string = DEFAULT_CONFIG_FILE_PATH,
): MergeVerdictConfig {
  try {
    const content = readFileSync(filePath, "utf8");
    return parseConfig(content);
  } catch (error) {
    if (isEnoent(error)) {
      return createDefaultConfig();
    }
    throw error;
  }
}
