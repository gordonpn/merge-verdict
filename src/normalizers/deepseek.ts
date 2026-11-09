import type { NormalizedFinding } from "../models/finding.js";
import type { ReviewerExecutionRecord, ReviewerVerdict } from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";

type RawVerdict = "APPROVE" | "APPROVE WITH MINOR FINDINGS" | "REQUEST CHANGES" | "BLOCK";

function extractRawVerdict(body: string): RawVerdict | null {
  const match = body.match(/##\s*Verdict:\s*([^\n\r]+)/i);
  if (!match?.[1]) {
    return null;
  }
  const clean = match[1].trim().toUpperCase();
  if (clean.includes("APPROVE WITH MINOR FINDINGS")) {
    return "APPROVE WITH MINOR FINDINGS";
  }
  if (clean.includes("APPROVE")) {
    return "APPROVE";
  }
  if (clean.includes("REQUEST CHANGES")) {
    return "REQUEST CHANGES";
  }
  if (clean.includes("BLOCK")) {
    return "BLOCK";
  }
  return null;
}

function parseMaterialFindings(body: string, rawVerdict: RawVerdict): NormalizedFinding[] {
  const sectionMatch = body.match(/###?\s*Material Findings([\s\S]*?)(?=###?|$)/i);
  if (!sectionMatch?.[1]) {
    return [];
  }
  const sectionText = sectionMatch[1].trim();
  if (sectionText.toLowerCase() === "none." || sectionText.toLowerCase() === "none") {
    return [];
  }

  const lines = sectionText.split("\n");
  const findings: NormalizedFinding[] = [];
  let index = 1;

  for (const line of lines) {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^[-*•\d.]+\s*(.+)$/);
    if (!bulletMatch?.[1]) {
      continue;
    }
    const findingText = bulletMatch[1].trim();
    if (findingText.toLowerCase() === "none." || findingText.toLowerCase() === "none") {
      continue;
    }

    let severity: Severity = "MEDIUM";
    let isBlocking = false;

    if (rawVerdict === "BLOCK") {
      severity = "BLOCKER";
      isBlocking = true;
    } else if (rawVerdict === "REQUEST CHANGES") {
      severity = "HIGH";
      isBlocking = true;
    } else if (rawVerdict === "APPROVE WITH MINOR FINDINGS") {
      severity = "LOW";
      isBlocking = false;
    }

    findings.push({
      id: `deepseek_finding_${index++}`,
      reviewerId: "deepseek-review",
      title: findingText.length > 120 ? `${findingText.slice(0, 117)}...` : findingText,
      description: findingText,
      severity,
      isBlocking,
      isResolved: !isBlocking,
    });
  }

  return findings;
}

/**
 * Normalizes DeepSeek review verdicts and material findings from workflow review submissions.
 *
 * @param input Pull request collection data.
 * @returns Normalized reviewer execution record for DeepSeek Review.
 */
export function normalizeDeepSeekReviewer(input: NormalizerInput): ReviewerExecutionRecord {
  const { headSha } = input;
  const review = input.reviews?.find((r) => r.body && /##\s*Verdict:/i.test(r.body));

  if (!review?.body) {
    return {
      reviewerId: "deepseek-review",
      reviewerName: "DeepSeek Review",
      status: "PENDING",
      evaluatedCommitSha: null,
      isFresh: false,
      verdict: "NONE",
      findings: [],
      checkRunConclusion: null,
    };
  }

  const evaluatedCommitSha = review.commitSha;
  const isFresh = evaluatedCommitSha !== null && evaluatedCommitSha === headSha;
  const rawVerdict = extractRawVerdict(review.body);

  if (!isFresh) {
    return {
      reviewerId: "deepseek-review",
      reviewerName: "DeepSeek Review",
      status: "STALE",
      evaluatedCommitSha,
      isFresh: false,
      verdict: "NONE",
      findings: [],
      checkRunConclusion: null,
    };
  }

  if (!rawVerdict) {
    return {
      reviewerId: "deepseek-review",
      reviewerName: "DeepSeek Review",
      status: "COMPLETED",
      evaluatedCommitSha,
      isFresh: true,
      verdict: "COMMENTED",
      findings: [],
      checkRunConclusion: null,
    };
  }

  const findings = parseMaterialFindings(review.body, rawVerdict);
  const verdict: ReviewerVerdict =
    rawVerdict === "APPROVE" || rawVerdict === "APPROVE WITH MINOR FINDINGS"
      ? "APPROVE"
      : "CHANGES_REQUESTED";

  return {
    reviewerId: "deepseek-review",
    reviewerName: "DeepSeek Review",
    status: "COMPLETED",
    evaluatedCommitSha,
    isFresh: true,
    verdict,
    findings,
    checkRunConclusion: null,
  };
}

/**
 * Adapter export for DeepSeek reviewer normalizer.
 */
export const deepSeekNormalizer: ReviewerNormalizer = {
  reviewerId: "deepseek-review",
  reviewerName: "DeepSeek Review",
  normalize: normalizeDeepSeekReviewer,
};
