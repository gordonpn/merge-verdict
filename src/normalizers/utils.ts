import { z } from "zod";
import type { GitHubCheckRun } from "../collector/github-collector.js";

const IsoDatetimeSchema = z.string().datetime();

/**
 * Strips leading and trailing Markdown formatting punctuation and whitespace from a string.
 *
 * @param str Input line text.
 * @returns Cleaned string without leading or trailing markdown formatting characters.
 */
export function stripMarkdownPunctuation(str: string): string {
  let start = 0;
  let end = str.length;
  const punctuation = new Set(["_", "*", "~", "`", "#", ">", "-", " ", "\t", "\r", "\n"]);
  while (start < end) {
    const char = str[start];
    if (char && punctuation.has(char)) {
      start++;
    } else {
      break;
    }
  }
  while (end > start) {
    const char = str[end - 1];
    if (char && punctuation.has(char)) {
      end--;
    } else {
      break;
    }
  }
  return str.slice(start, end);
}

/** Returns a valid UTC ISO datetime, or undefined for missing or invalid input. */
export function parseIsoTimestamp(value: string | null | undefined): string | undefined {
  return value && IsoDatetimeSchema.safeParse(value).success ? value : undefined;
}

/** Returns the completion timestamp of a rate-limit check for the current head. */
export function rateLimitCheckTimestamp(
  checkRun: GitHubCheckRun | undefined,
  headSha: string,
  patterns: readonly RegExp[],
): string | undefined {
  if (!checkRun || checkRun.commitSha !== headSha || checkRun.status !== "completed") {
    return undefined;
  }
  const output = [checkRun.output.title, checkRun.output.summary, checkRun.output.text].join(" ");
  // Match from the start without changing caller-owned global or sticky regex state.
  return patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(output))
    ? parseIsoTimestamp(checkRun.completedAt)
    : undefined;
}
