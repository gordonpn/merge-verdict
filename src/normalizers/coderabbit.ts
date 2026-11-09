import type { GitHubCheckRun } from "../collector/github-collector.js";
import type { NormalizedFinding } from "../models/finding.js";
import type {
  ReviewerExecutionRecord,
  ReviewerStatus,
  ReviewerVerdict,
} from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";

const CODERABBIT_LOGINS = new Set(["coderabbitai", "coderabbitai[bot]"]);
const RATE_LIMIT_PATTERNS = [
  /review limit reached/i,
  /rate limited by coderabbit\.ai/i,
  /free oss reviews/i,
  /free limit to reset/i,
  /rate limited/i,
];

function isCodeRabbitAuthor(login: string | null): boolean {
  return login !== null && CODERABBIT_LOGINS.has(login.toLowerCase());
}

function isRateLimited(checkRun: GitHubCheckRun | undefined, input: NormalizerInput): boolean {
  if (checkRun?.conclusion === "neutral") {
    const textToCheck = `${checkRun.output.title ?? ""} ${checkRun.output.summary ?? ""} ${
      checkRun.output.text ?? ""
    }`;
    if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(textToCheck))) {
      return true;
    }
  }

  for (const comment of input.conversationComments ?? []) {
    if (isCodeRabbitAuthor(comment.authorLogin)) {
      if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(comment.body ?? ""))) {
        return true;
      }
    }
  }

  return false;
}

function parseSeverity(body: string): Severity {
  if (/critical|blocker|security vulnerability/i.test(body)) {
    return "BLOCKER";
  }
  if (/potential issue|bug|error|vulnerability/i.test(body)) {
    return "HIGH";
  }
  if (/refactor|optimization|performance|suggestion/i.test(body)) {
    return "MEDIUM";
  }
  if (/nitpick|style|trivial|typo/i.test(body)) {
    return "LOW";
  }
  return "MEDIUM";
}

function extractTitle(body: string, path: string | null, line: number | null): string {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const lineText of lines) {
    if (lineText.startsWith("<!--") || lineText.startsWith("#") || lineText.startsWith(">")) {
      continue;
    }
    const clean = lineText.replace(/^[_*~`#]+|[_*~`#]+$/g, "").trim();
    if (clean.length > 0) {
      return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
    }
  }
  return path && line ? `CodeRabbit finding on ${path}:${line}` : "CodeRabbit finding";
}

function isSummaryComment(body: string): boolean {
  return (
    body.includes("<!-- This is an auto-generated comment: summarize by coderabbit.ai -->") ||
    body.includes("<!-- This is an auto-generated comment: walkthrough by coderabbit.ai -->") ||
    /^#+\s*(Summary|Walkthrough|Overview)/i.test(body.trim())
  );
}

/**
 * Normalizes CodeRabbit review signals, check runs, and inline findings.
 *
 * @param input Pull request collection data.
 * @returns Normalized reviewer execution record for CodeRabbit.
 */
export function normalizeCodeRabbitReviewer(input: NormalizerInput): ReviewerExecutionRecord {
  const { headSha } = input;
  const checkRun = input.checkRuns?.find((c) => c.name.toLowerCase() === "coderabbit");
  const reviews = input.reviews?.filter((r) => isCodeRabbitAuthor(r.reviewerLogin)) ?? [];
  const threads =
    input.reviewThreads?.filter((t) => {
      const firstComment = t.comments[0];
      return firstComment ? isCodeRabbitAuthor(firstComment.authorLogin) : false;
    }) ?? [];

  const evaluatedCommitSha = checkRun?.commitSha ?? reviews[reviews.length - 1]?.commitSha ?? null;

  const isFresh = evaluatedCommitSha === headSha;

  if (isRateLimited(checkRun, input)) {
    return {
      reviewerId: "coderabbitai",
      reviewerName: "CodeRabbit",
      status: "RATE_LIMITED",
      evaluatedCommitSha,
      isFresh: false,
      verdict: "NONE",
      summary: "CodeRabbit review limit reached.",
      findings: [],
      checkRunConclusion: checkRun?.conclusion ?? "neutral",
    };
  }

  const findings: NormalizedFinding[] = [];
  for (const thread of threads) {
    const firstComment = thread.comments[0];
    if (!firstComment || isSummaryComment(firstComment.body)) {
      continue;
    }

    const severity = parseSeverity(firstComment.body);
    const isBlocking =
      !thread.isResolved &&
      (severity === "BLOCKER" || severity === "HIGH" || severity === "MEDIUM");
    const finding: NormalizedFinding = {
      id: thread.id,
      reviewerId: "coderabbitai",
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
    findings.push(finding);
  }

  let status: ReviewerStatus = "PENDING";
  let verdict: ReviewerVerdict = "NONE";

  if (!checkRun && reviews.length === 0 && threads.length === 0) {
    status = "PENDING";
    verdict = "NONE";
  } else if (!isFresh) {
    status = "STALE";
    verdict = "NONE";
  } else if (checkRun?.status === "in_progress" || checkRun?.status === "queued") {
    status = "PENDING";
    verdict = "NONE";
  } else if (checkRun?.conclusion === "failure") {
    status = "FAILED";
    verdict = "CHANGES_REQUESTED";
  } else {
    status = "COMPLETED";
    const hasUnresolvedBlockingFindings = findings.some((f) => f.isBlocking && !f.isResolved);
    if (hasUnresolvedBlockingFindings) {
      verdict = "CHANGES_REQUESTED";
    } else {
      verdict = "APPROVE";
    }
  }

  return {
    reviewerId: "coderabbitai",
    reviewerName: "CodeRabbit",
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
 * Adapter export for CodeRabbit normalizer.
 */
export const codeRabbitNormalizer: ReviewerNormalizer = {
  reviewerId: "coderabbitai",
  reviewerName: "CodeRabbit",
  normalize: normalizeCodeRabbitReviewer,
};
