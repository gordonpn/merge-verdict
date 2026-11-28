import type { GitHubReviewSubmission } from "../collector/github-collector.js";
import type { NormalizedFinding } from "../models/finding.js";
import type {
  ReviewerExecutionRecord,
  ReviewerStatus,
  ReviewerVerdict,
} from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { parseIsoTimestamp, resolveThreadLineRange, stripMarkdownPunctuation } from "./utils.js";

const COPILOT_LOGINS = new Set([
  "copilot-pull-request-reviewer[bot]",
  "copilot-pull-request-reviewer",
]);

const RATE_LIMIT_PATTERNS = [
  /unable to review\b[^\n]*\b(?:insufficient remaining quota|quota|rate limit)/i,
  /insufficient remaining quota/i,
];

function isCopilotAuthor(login: string | null): boolean {
  return login !== null && COPILOT_LOGINS.has(login.toLowerCase());
}

function isRateLimitedReview(review: GitHubReviewSubmission | undefined): boolean {
  if (review?.state !== "COMMENTED" || !review.body) {
    return false;
  }
  const body = review.body;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(body));
}

function extractCopilotTitle(body: string, path: string | null, line: number | null): string {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const lineText of lines) {
    if (lineText.startsWith("<!--") || lineText.startsWith(">")) {
      continue;
    }
    const clean = stripMarkdownPunctuation(lineText);
    if (clean.length > 0) {
      return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
    }
  }
  return path && line ? `Copilot finding on ${path}:${line}` : "Copilot finding";
}

/**
 * Normalizes GitHub Copilot reviewer submissions, inline threads, and approval states.
 *
 * @param input Pull request collection data.
 * @returns Normalized reviewer execution record for Copilot.
 */
export function normalizeCopilotReviewer(input: NormalizerInput): ReviewerExecutionRecord {
  const { headSha } = input;
  const reviews = input.reviews?.filter((r) => isCopilotAuthor(r.reviewerLogin)) ?? [];
  const threads =
    input.reviewThreads?.filter(
      (
        t,
      ): t is typeof t & {
        comments: readonly [
          (typeof t.comments)[number],
          ...(readonly (typeof t.comments)[number][]),
        ];
      } => {
        const firstComment = t.comments[0];
        return firstComment ? isCopilotAuthor(firstComment.authorLogin) : false;
      },
    ) ?? [];

  const latestReview = reviews[reviews.length - 1];
  const evaluatedCommitSha = latestReview?.commitSha ?? null;
  const isFresh = evaluatedCommitSha !== null && evaluatedCommitSha === headSha;

  const findings: NormalizedFinding[] = [];
  for (const thread of threads) {
    const firstComment = thread.comments[0];

    const severity: Severity = thread.isResolved ? "LOW" : "HIGH";
    const isBlocking = !thread.isResolved;
    const lineRange = resolveThreadLineRange(thread);

    const finding: NormalizedFinding = {
      id: thread.id,
      reviewerId: "copilot",
      threadId: thread.id,
      title: extractCopilotTitle(firstComment.body, thread.path, lineRange.lineNumber ?? null),
      description: firstComment.body,
      severity,
      isBlocking,
      isResolved: thread.isResolved,
    };
    if (thread.path) {
      finding.filePath = thread.path;
    }
    if (lineRange.startLineNumber !== undefined) {
      finding.startLineNumber = lineRange.startLineNumber;
    }
    if (lineRange.lineNumber !== undefined) {
      finding.lineNumber = lineRange.lineNumber;
    }
    if (thread.resolvedByLogin) {
      finding.resolvedBy = thread.resolvedByLogin;
    }
    // Keep each position with the commit and path reported on the same comment.
    // Thread positions can move independently, so they cannot supply link provenance.
    if (input.repository && firstComment.path) {
      const validLine = (line: number | null): line is number =>
        typeof line === "number" && Number.isInteger(line) && line > 0;
      const currentLine = validLine(firstComment.line) ? firstComment.line : null;
      const originalLine = validLine(firstComment.originalLine) ? firstComment.originalLine : null;
      const useCurrent = firstComment.commitSha && currentLine !== null;
      const useOriginal = !useCurrent && firstComment.originalCommitSha && originalLine !== null;
      const commitSha = useCurrent
        ? firstComment.commitSha
        : useOriginal
          ? firstComment.originalCommitSha
          : firstComment.commitSha || firstComment.originalCommitSha;
      const line = useCurrent ? currentLine : useOriginal ? originalLine : null;
      if (commitSha) {
        const linePart = line === null ? "" : `#L${line}`;
        finding.rawCommentUrl = `https://github.com/${input.repository}/blob/${commitSha}/${firstComment.path}${linePart}`;
      }
    }
    findings.push(finding);
  }

  let status: ReviewerStatus = "PENDING";
  let verdict: ReviewerVerdict = "NONE";
  let rateLimitedAt: string | undefined;
  const hasUnresolvedBlocking = findings.some((f) => f.isBlocking && !f.isResolved);

  if (!latestReview && threads.length === 0) {
    status = "PENDING";
    verdict = "NONE";
  } else if (evaluatedCommitSha !== null && !isFresh) {
    status = "STALE";
    verdict = "NONE";
  } else if (isRateLimitedReview(latestReview)) {
    status = "RATE_LIMITED";
    verdict = hasUnresolvedBlocking ? "CHANGES_REQUESTED" : "NONE";
    rateLimitedAt = isFresh ? parseIsoTimestamp(latestReview?.submittedAt) : undefined;
  } else {
    status = "COMPLETED";
    if (latestReview?.state === "CHANGES_REQUESTED" || hasUnresolvedBlocking) {
      verdict = "CHANGES_REQUESTED";
    } else if (latestReview?.state === "APPROVED") {
      verdict = "APPROVE";
    } else if (latestReview?.state === "COMMENTED") {
      verdict = "COMMENTED";
    } else {
      verdict = "NONE";
    }
  }

  return {
    reviewerId: "copilot",
    reviewerName: "GitHub Copilot",
    status,
    evaluatedCommitSha,
    isFresh,
    verdict,
    summary: latestReview?.body ?? undefined,
    ...(rateLimitedAt ? { rateLimitedAt } : {}),
    findings,
    checkRunConclusion: null,
  };
}

/**
 * Adapter export for GitHub Copilot normalizer.
 */
export const copilotNormalizer: ReviewerNormalizer = {
  reviewerId: "copilot",
  reviewerName: "GitHub Copilot",
  normalize: normalizeCopilotReviewer,
};
