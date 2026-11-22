import type { NormalizedFinding } from "../models/finding.js";
import type {
  ReviewerExecutionRecord,
  ReviewerStatus,
  ReviewerVerdict,
} from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { stripMarkdownPunctuation } from "./utils.js";

type RawVerdict = "APPROVE" | "APPROVE WITH MINOR FINDINGS" | "REQUEST CHANGES" | "BLOCK";

const DEEPSEEK_LOGINS = new Set(["github-actions", "github-actions[bot]"]);
const DEEPSEEK_CHECK_NAMES = new Set([
  "runner / deepseek-review",
  "deepseek review",
  "deepseek-review",
]);
// Avoid /g on module-level patterns; selection and extraction stay stateless.
const VERDICT_HEADING_PRESENT =
  /##\s*Verdict\b(?::|[ \t]*(?:\r?\n|$)|[ \t]+[*_`~]*(?:BLOCK|REQUEST[_ ]CHANGES|APPROVE))/i;
// Extract only the heading line or first non-empty line after it so prose never supplies a verdict.
const VERDICT_HEADING_VALUE = /##\s*Verdict\b:?[ \t]*(?:\r?\n[ \t]*)*([^\n\r]+)/i;

function isDeepSeekAuthor(login: string | null): boolean {
  return login !== null && DEEPSEEK_LOGINS.has(login.toLowerCase());
}

function extractRawVerdict(body: string): RawVerdict | null {
  const match = body.match(VERDICT_HEADING_VALUE);
  if (!match?.[1]) {
    return null;
  }
  const clean = stripMarkdownPunctuation(match[1].replaceAll("_", " ")).toUpperCase();
  if (/\bBLOCK\b/.test(clean)) {
    return "BLOCK";
  }
  if (/\bREQUEST CHANGES\b/.test(clean)) {
    return "REQUEST CHANGES";
  }
  if (/^APPROVE WITH MINOR FINDINGS\b/.test(clean)) {
    return "APPROVE WITH MINOR FINDINGS";
  }
  if (/^APPROVE\b/.test(clean)) {
    return "APPROVE";
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
  const matchingReviews =
    input.reviews?.filter(
      (r) => isDeepSeekAuthor(r.reviewerLogin) && r.body && VERDICT_HEADING_PRESENT.test(r.body),
    ) ?? [];
  const review = matchingReviews[matchingReviews.length - 1];
  const checkRun = input.checkRuns?.find((c) => DEEPSEEK_CHECK_NAMES.has(c.name.toLowerCase()));
  const checkRunConclusion = checkRun?.conclusion ?? null;

  if (review?.body && review.commitSha === headSha) {
    const evaluatedCommitSha = review.commitSha;
    const rawVerdict = extractRawVerdict(review.body);

    if (!rawVerdict) {
      return {
        reviewerId: "deepseek-review",
        reviewerName: "DeepSeek Review",
        status: "COMPLETED",
        evaluatedCommitSha,
        isFresh: true,
        verdict: "COMMENTED",
        findings: [],
        checkRunConclusion,
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
      checkRunConclusion,
    };
  }

  if (checkRun) {
    const evaluatedCommitSha = checkRun.commitSha;
    const isFresh = evaluatedCommitSha === headSha;
    let status: ReviewerStatus = "PENDING";

    if (!isFresh) {
      status = "STALE";
    } else if (checkRun.status !== "completed") {
      status = "PENDING";
    } else if (
      checkRun.conclusion === "skipped" ||
      checkRun.conclusion === "neutral" ||
      checkRun.conclusion === "success"
    ) {
      status = "SKIPPED";
    } else {
      status = "FAILED";
    }

    return {
      reviewerId: "deepseek-review",
      reviewerName: "DeepSeek Review",
      status,
      evaluatedCommitSha,
      isFresh,
      verdict: "NONE",
      findings: [],
      checkRunConclusion,
    };
  }

  if (review?.body) {
    return {
      reviewerId: "deepseek-review",
      reviewerName: "DeepSeek Review",
      status: "STALE",
      evaluatedCommitSha: review.commitSha,
      isFresh: false,
      verdict: "NONE",
      findings: [],
      checkRunConclusion: null,
    };
  }

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

/**
 * Adapter export for DeepSeek reviewer normalizer.
 */
export const deepSeekNormalizer: ReviewerNormalizer = {
  reviewerId: "deepseek-review",
  reviewerName: "DeepSeek Review",
  normalize: normalizeDeepSeekReviewer,
};
