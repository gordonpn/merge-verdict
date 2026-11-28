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
const NUMBERED_FINDING_HEADING = /^###[^\S\r\n]+\d+\.[^\S\r\n]+(\S[^\r\n]*)$/;
const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HORIZONTAL_RULE = /^ {0,3}(?:[-*_][ \t]*){3,}$/;
const EXPLICIT_SEVERITY_PREFIX =
  /^(?:\[(BLOCKER|CRITICAL|HIGH|MEDIUM|LOW|ADVISORY|INFO)\](?::|[^\S\r\n]+|[-\u2013\u2014])|\*\*(BLOCKER|CRITICAL|HIGH|MEDIUM|LOW|ADVISORY|INFO)\*\*(?::|[^\S\r\n]*[-\u2013\u2014]|[^\S\r\n]+)|(BLOCKER|CRITICAL|HIGH|MEDIUM|LOW|ADVISORY|INFO)(?::|[^\S\r\n]+[-\u2013\u2014]))/i;
const EXPLICIT_SEVERITY_MAP: Readonly<Record<string, Severity>> = {
  BLOCKER: "BLOCKER",
  CRITICAL: "BLOCKER",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  ADVISORY: "ADVISORY",
  INFO: "ADVISORY",
};
const VERDICT_TOKEN_LOOKAHEAD = String.raw`[*_\x60~]*(?:BLOCK|REQUEST[_ ]CHANGES|APPROVE)(?![A-Za-z0-9])`;
const QUALIFIED_VERDICT_PREFIX = String.raw`##\s*Verdict\b(?::|[ \t]*(?:\r?\n[ \t]*)+(?=${VERDICT_TOKEN_LOOKAHEAD})|[ \t]+(?=${VERDICT_TOKEN_LOOKAHEAD}))`;
// Avoid /g on module-level patterns; selection and extraction stay stateless.
const VERDICT_HEADING_PRESENT = new RegExp(QUALIFIED_VERDICT_PREFIX, "i");
// Share heading qualification with selection and stop before nested Markdown headings.
const VERDICT_HEADING_VALUE = new RegExp(
  String.raw`${QUALIFIED_VERDICT_PREFIX}[ \t]*(?:\r?\n[ \t]*)*(?!#)([^\n\r]+)`,
  "i",
);

function isDeepSeekAuthor(login: string | null): boolean {
  return login !== null && DEEPSEEK_LOGINS.has(login.toLowerCase());
}

function extractRawVerdict(body: string): RawVerdict | null {
  const match = body.match(VERDICT_HEADING_VALUE);
  if (!match?.[1]) {
    return null;
  }
  const clean = stripMarkdownPunctuation(match[1].replaceAll("_", " ")).toUpperCase();
  if (/^BLOCK\b/.test(clean)) {
    return "BLOCK";
  }
  if (/^REQUEST CHANGES\b/.test(clean)) {
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

interface FenceState {
  char: "`" | "~";
  length: number;
}

function nextFenceState(line: string, current: FenceState | null): FenceState | null {
  if (current) {
    const closeMatch = FENCE_CLOSING.exec(line);
    const marker = closeMatch?.[1];
    if (marker && marker[0] === current.char && marker.length >= current.length) {
      return null;
    }
    return current;
  }

  const openMatch = FENCE_OPENING.exec(line);
  const marker = openMatch?.[1];
  if (!marker) {
    return null;
  }
  const char = marker[0] === "`" ? "`" : "~";
  const info = openMatch[2] ?? "";
  // CommonMark forbids backticks in the info string of a backtick fence.
  if (char === "`" && info.includes("`")) {
    return null;
  }
  return { char, length: marker.length };
}

function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]?.trim().length === 0) {
    start++;
  }
  let end = lines.length;
  while (end > start && lines[end - 1]?.trim().length === 0) {
    end--;
  }
  return lines.slice(start, end);
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
  let fence: FenceState | null = null;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (isFirstLine) {
      isFirstLine = false;
      if (trimmed.length > 0) {
        sectionLines.push(trimmed);
      }
      continue;
    }
    if (!fence && /^#{2,3}\s/.test(trimmed) && !NUMBERED_FINDING_HEADING.test(trimmed)) {
      break;
    }
    fence = nextFenceState(line, fence);
    sectionLines.push(line);
  }
  return trimBlankLines(sectionLines).join("\n");
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

function extractExplicitSeverity(findingText: string): Severity | null {
  const match = EXPLICIT_SEVERITY_PREFIX.exec(findingText.trim());
  const rawToken = match?.[1] ?? match?.[2] ?? match?.[3];
  return rawToken ? (EXPLICIT_SEVERITY_MAP[rawToken.toUpperCase()] ?? null) : null;
}

const DEFAULT_SEVERITY_BY_VERDICT: Readonly<Record<RawVerdict, Severity>> = {
  BLOCK: "BLOCKER",
  "REQUEST CHANGES": "HIGH",
  "APPROVE WITH MINOR FINDINGS": "LOW",
  APPROVE: "MEDIUM",
};

function defaultSeverityForVerdict(rawVerdict: RawVerdict): Severity {
  return DEFAULT_SEVERITY_BY_VERDICT[rawVerdict];
}

function parseMaterialFindings(body: string, rawVerdict: RawVerdict): NormalizedFinding[] {
  const sectionText = extractMaterialFindingsSection(body);
  if (!sectionText) {
    return [];
  }
  const normalizedSection = sectionText.trim().toLowerCase();
  if (normalizedSection === "none." || normalizedSection === "none") {
    return [];
  }

  const lines = sectionText.split("\n");
  const entries: [string, ...string[]][] = [];
  let subsection: [string, ...string[]] | undefined;
  let fence: FenceState | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence) {
      fence = nextFenceState(line, fence);
      if (subsection) {
        subsection.push(line);
      }
      continue;
    }

    const heading = trimmed.match(NUMBERED_FINDING_HEADING)?.[1]?.trim();
    if (heading) {
      subsection = [heading];
      entries.push(subsection);
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) {
      continue;
    }
    const nextFence = nextFenceState(line, null);
    if (nextFence) {
      fence = nextFence;
      if (subsection) {
        subsection.push(line);
      }
      continue;
    }
    if (subsection) {
      if (trimmed.length > 0) {
        subsection.push(line);
      }
      continue;
    }
    const bullet = parseBulletLine(line);
    if (bullet) entries.push([bullet]);
  }
  const findings: NormalizedFinding[] = [];
  const defaultSeverity = defaultSeverityForVerdict(rawVerdict);
  const isBlockingVerdict = rawVerdict === "BLOCK" || rawVerdict === "REQUEST CHANGES";
  let index = 1;

  for (const rawEntry of entries) {
    const [heading, ...bodyLines] = rawEntry;
    const entry: [string, ...string[]] = [heading, ...trimBlankLines(bodyLines)];
    const findingText = entry[0];
    if (findingText.toLowerCase() === "none." || findingText.toLowerCase() === "none") {
      continue;
    }

    const severity = extractExplicitSeverity(findingText) ?? defaultSeverity;
    const isBlocking =
      isBlockingVerdict && (severity === "BLOCKER" || severity === "HIGH" || severity === "MEDIUM");

    findings.push({
      id: `deepseek_finding_${index++}`,
      reviewerId: "deepseek-review",
      title: findingText.length > 120 ? `${findingText.slice(0, 117)}...` : findingText,
      description: entry.join("\n"),
      severity,
      isBlocking,
      // Keep findings open under blocking verdicts so policy thresholds and check reports can still inspect LOW/ADVISORY items.
      isResolved: !isBlockingVerdict,
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
