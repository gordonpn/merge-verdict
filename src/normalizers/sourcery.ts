import type { NormalizedFinding } from "../models/finding.js";
import type {
  ReviewerExecutionRecord,
  ReviewerStatus,
  ReviewerVerdict,
} from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { stripMarkdownPunctuation } from "./utils.js";

const SOURCERY_LOGINS = new Set(["sourcery-ai", "sourcery-ai[bot]"]);

function isSourceryAuthor(login: string | null): boolean {
  return login !== null && SOURCERY_LOGINS.has(login.toLowerCase());
}

function parseSeverity(body: string): Severity {
  if (/\bHigh\b/i.test(body)) {
    return "HIGH";
  }
  if (/\bMedium\b/i.test(body)) {
    return "MEDIUM";
  }
  if (/\bLow\b/i.test(body)) {
    return "LOW";
  }
  return "MEDIUM";
}

function parseAcknowledgedCommitSha(body: string): string | undefined {
  const match = body.match(/Addressed in\s+\[?([a-f0-9]{7,40})\]?/i);
  return match ? match[1] : undefined;
}

function extractTitle(body: string, path: string | null, line: number | null): string {
  const match = body.match(/(?:High|Medium|Low)\s*[·•-]\s*([^\n\r]+)/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const lineText of lines) {
    if (lineText.startsWith("<!--") || lineText.startsWith("#") || lineText.startsWith(">")) {
      continue;
    }
    const clean = stripMarkdownPunctuation(lineText);
    if (clean.length > 0) {
      return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
    }
  }
  return path && line ? `Sourcery finding on ${path}:${line}` : "Sourcery finding";
}

/**
 * Normalizes Sourcery review signals, check runs, and inline findings.
 *
 * @param input Pull request collection data.
 * @returns Normalized reviewer execution record for Sourcery.
 */
export function normalizeSourceryReviewer(input: NormalizerInput): ReviewerExecutionRecord {
  const { headSha } = input;
  const checkRun = input.checkRuns?.find((c) => c.name.toLowerCase() === "sourcery review");
  const reviews = input.reviews?.filter((r) => isSourceryAuthor(r.reviewerLogin)) ?? [];
  const threads =
    input.reviewThreads?.filter((t) => {
      const firstComment = t.comments[0];
      return firstComment ? isSourceryAuthor(firstComment.authorLogin) : false;
    }) ?? [];

  const evaluatedCommitSha = checkRun?.commitSha ?? reviews[reviews.length - 1]?.commitSha ?? null;

  const isFresh = evaluatedCommitSha === headSha;

  const findings: NormalizedFinding[] = [];
  for (const thread of threads) {
    const firstComment = thread.comments[0];
    if (!firstComment) {
      continue;
    }

    const severity = parseSeverity(firstComment.body);
    const isBlocking = !thread.isResolved && (severity === "HIGH" || severity === "MEDIUM");
    const acknowledgedSha = parseAcknowledgedCommitSha(firstComment.body);

    const finding: NormalizedFinding = {
      id: thread.id,
      reviewerId: "sourcery-ai",
      threadId: thread.id,
      title: extractTitle(firstComment.body, thread.path, thread.line ?? thread.originalLine),
      description: firstComment.body,
      severity,
      isBlocking,
      isResolved: thread.isResolved,
    };
    if (thread.path) {
      finding.filePath = thread.path;
    }
    const lineNum = thread.line ?? thread.originalLine;
    if (typeof lineNum === "number" && lineNum > 0) {
      finding.lineNumber = lineNum;
    }
    if (thread.resolvedByLogin) {
      finding.resolvedBy = thread.resolvedByLogin;
    }
    if (acknowledgedSha) {
      finding.acknowledgedCommitSha = acknowledgedSha;
    }
    findings.push(finding);
  }

  let status: ReviewerStatus = "PENDING";
  let verdict: ReviewerVerdict = "NONE";

  const latestReview = reviews[reviews.length - 1];
  const hasUnresolvedBlockingFindings = findings.some((f) => f.isBlocking && !f.isResolved);
  const isChangesRequested =
    latestReview?.state === "CHANGES_REQUESTED" || hasUnresolvedBlockingFindings;

  if (!checkRun && reviews.length === 0 && threads.length === 0) {
    status = "PENDING";
    verdict = "NONE";
  } else if (!isFresh) {
    status = "STALE";
    verdict = "NONE";
  } else if (checkRun && checkRun.status !== "completed") {
    status = "PENDING";
    verdict = "NONE";
  } else if (checkRun && checkRun.conclusion !== "success") {
    status = "FAILED";
    verdict =
      checkRun.conclusion === "failure" || isChangesRequested ? "CHANGES_REQUESTED" : "NONE";
  } else {
    status = "COMPLETED";
    if (isChangesRequested) {
      verdict = "CHANGES_REQUESTED";
    } else {
      verdict = "APPROVE";
    }
  }

  return {
    reviewerId: "sourcery-ai",
    reviewerName: "Sourcery",
    status,
    evaluatedCommitSha,
    isFresh,
    verdict,
    summary: checkRun?.output.summary ?? undefined,
    findings,
    checkRunConclusion: checkRun?.conclusion ?? null,
  };
}

/**
 * Adapter export for Sourcery normalizer.
 */
export const sourceryNormalizer: ReviewerNormalizer = {
  reviewerId: "sourcery-ai",
  reviewerName: "Sourcery",
  normalize: normalizeSourceryReviewer,
};
