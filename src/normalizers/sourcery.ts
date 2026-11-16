import type { GitHubCheckRun, GitHubReviewSubmission } from "../collector/github-collector.js";
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
const RATE_LIMIT_PATTERNS = [
  /review budget/i,
  /diff characters for the last \d+ days/i,
  /intent=rate_limit_hit/i,
  /rate limit/i,
  /review limit/i,
];

function isSourceryAuthor(login: string | null): boolean {
  return login !== null && SOURCERY_LOGINS.has(login.toLowerCase());
}

function isRateLimited(
  checkRun: GitHubCheckRun | undefined,
  reviews: readonly GitHubReviewSubmission[],
  input: NormalizerInput,
): boolean {
  const hasFreshSuccessCheck =
    checkRun?.status === "completed" &&
    checkRun.conclusion === "success" &&
    checkRun.commitSha === input.headSha;
  const latestReview = reviews[reviews.length - 1];
  const hasFreshReview = latestReview?.commitSha === input.headSha;

  if (hasFreshSuccessCheck || hasFreshReview) {
    return false;
  }

  if (checkRun && (checkRun.conclusion === "skipped" || checkRun.conclusion === "neutral")) {
    const textToCheck = `${checkRun.output.title ?? ""} ${checkRun.output.summary ?? ""} ${
      checkRun.output.text ?? ""
    }`;
    if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(textToCheck))) {
      return true;
    }
  }

  const checkCompletedAt = checkRun?.completedAt ? Date.parse(checkRun.completedAt) : Number.NaN;
  const comments = (input.conversationComments ?? []).filter((c) =>
    isSourceryAuthor(c.authorLogin),
  );
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!comment?.body) {
      continue;
    }
    const timestamp = comment.updatedAt ?? comment.createdAt;
    if (!Number.isNaN(checkCompletedAt) && timestamp) {
      const commentTime = Date.parse(timestamp);
      if (!Number.isNaN(commentTime) && commentTime < checkCompletedAt) {
        continue;
      }
    }
    if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(comment.body ?? ""))) {
      return true;
    }
  }

  return false;
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
    const acknowledgedSha = parseAcknowledgedCommitSha(firstComment.body);
    const knownCommitShas = new Set(
      [input.headSha, ...(input.ancestorCommitShas ?? [])].map((sha) => sha.toLowerCase()),
    );
    const matchingCommitShas = acknowledgedSha
      ? [...knownCommitShas].filter((sha) => sha.startsWith(acknowledgedSha.toLowerCase()))
      : [];
    const isAcknowledgedInAncestry = !acknowledgedSha || matchingCommitShas.length === 1;

    const isResolved = thread.isResolved && isAcknowledgedInAncestry;
    const isBlocking = !isResolved && (severity === "HIGH" || severity === "MEDIUM");

    const finding: NormalizedFinding = {
      id: thread.id,
      reviewerId: "sourcery-ai",
      threadId: thread.id,
      title: extractTitle(firstComment.body, thread.path, thread.line ?? thread.originalLine),
      description: firstComment.body,
      severity,
      isBlocking,
      isResolved,
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
  const rateLimited = isRateLimited(checkRun, reviews, input);

  if (rateLimited && (!checkRun || checkRun.commitSha === headSha)) {
    status = "RATE_LIMITED";
    verdict = isChangesRequested ? "CHANGES_REQUESTED" : "NONE";
  } else if (!checkRun && reviews.length === 0 && threads.length === 0) {
    status = "PENDING";
    verdict = "NONE";
  } else if (!isFresh) {
    status = "STALE";
    verdict = "NONE";
  } else if (checkRun && checkRun.status !== "completed") {
    status = "PENDING";
    verdict = "NONE";
  } else if (checkRun && checkRun.conclusion === "skipped") {
    status = "SKIPPED";
    verdict = isChangesRequested ? "CHANGES_REQUESTED" : "NONE";
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
