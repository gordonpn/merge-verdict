import type { NormalizedFinding } from "../models/finding.js";
import type {
  ReviewerExecutionRecord,
  ReviewerStatus,
  ReviewerVerdict,
} from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { stripMarkdownPunctuation } from "./utils.js";

const COPILOT_LOGINS = new Set([
  "copilot-pull-request-reviewer[bot]",
  "copilot-pull-request-reviewer",
]);

function isCopilotAuthor(login: string | null): boolean {
  return login !== null && COPILOT_LOGINS.has(login.toLowerCase());
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

    const finding: NormalizedFinding = {
      id: thread.id,
      reviewerId: "copilot",
      threadId: thread.id,
      title: extractCopilotTitle(
        firstComment.body,
        thread.path,
        thread.line ?? thread.originalLine,
      ),
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
    if (input.repository && firstComment.commitSha && thread.path) {
      const linePart = typeof lineNum === "number" && lineNum > 0 ? `#L${lineNum}` : "";
      finding.rawCommentUrl = `https://github.com/${input.repository}/blob/${firstComment.commitSha}/${thread.path}${linePart}`;
    }
    findings.push(finding);
  }

  let status: ReviewerStatus = "PENDING";
  let verdict: ReviewerVerdict = "NONE";

  if (!latestReview && threads.length === 0) {
    status = "PENDING";
    verdict = "NONE";
  } else if (evaluatedCommitSha !== null && !isFresh) {
    status = "STALE";
    verdict = "NONE";
  } else {
    status = "COMPLETED";
    const hasUnresolvedBlocking = findings.some((f) => f.isBlocking && !f.isResolved);
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
