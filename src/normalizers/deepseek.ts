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

function extractMaterialFindingsSection(body: string): string | null {
  const marker = "Material Findings";
  const markerIndex = body.toLowerCase().indexOf(marker.toLowerCase());
  if (markerIndex === -1) {
    return null;
  }
  const afterMarker = body.slice(markerIndex + marker.length);
  const lines = afterMarker.split("\n");
  const sectionLines: string[] = [];
  let isFirstLine = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isFirstLine) {
      isFirstLine = false;
      if (trimmed.length > 0) {
        sectionLines.push(trimmed);
      }
      continue;
    }
    if (trimmed.startsWith("##") || trimmed.startsWith("###")) {
      break;
    }
    sectionLines.push(trimmed);
  }
  return sectionLines.join("\n").trim();
}

function parseBulletLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("* ") || trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
    return trimmed.slice(2).trim();
  }
  const dotIndex = trimmed.indexOf(". ");
  if (dotIndex > 0 && dotIndex <= 3 && /^\d+$/.test(trimmed.slice(0, dotIndex))) {
    return trimmed.slice(dotIndex + 2).trim();
  }
  return null;
}

function parseMaterialFindings(body: string, rawVerdict: RawVerdict): NormalizedFinding[] {
  const sectionText = extractMaterialFindingsSection(body);
  if (!sectionText) {
    return [];
  }
  if (sectionText.toLowerCase() === "none." || sectionText.toLowerCase() === "none") {
    return [];
  }

  const lines = sectionText.split("\n");
  const findings: NormalizedFinding[] = [];
  let index = 1;

  for (const line of lines) {
    const findingText = parseBulletLine(line);
    if (!findingText) {
      continue;
    }
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
