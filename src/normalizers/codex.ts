import type { NormalizedFinding } from "../models/finding.js";
import type {
  ReviewerExecutionRecord,
  ReviewerStatus,
  ReviewerVerdict,
} from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { stripMarkdownPunctuation } from "./utils.js";

const CODEX_LOGINS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);

interface CodexReviewStateJson {
  code_review?: {
    commit_sha?: string | null;
    has_any_findings?: boolean | null;
    has_unresolved_findings?: boolean | null;
    status?: string | null;
  } | null;
  security_review?: {
    commit_sha?: string | null;
    has_any_findings?: boolean | null;
    has_unresolved_findings?: boolean | null;
    status?: string | null;
  } | null;
}

function isCodexAuthor(login: string | null): boolean {
  return login !== null && CODEX_LOGINS.has(login.toLowerCase());
}

function parseCodexState(input: NormalizerInput): CodexReviewStateJson | null {
  const comments = [...(input.conversationComments ?? []), ...(input.reviews ?? [])];
  const marker = "codex-review-state:v1";
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    const body = c && "body" in c ? c.body : null;
    if (!body) {
      continue;
    }
    const markerIndex = body.indexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    const openBrace = body.indexOf("{", markerIndex + marker.length);
    if (openBrace === -1) {
      continue;
    }
    const commentClose = body.indexOf("-->", openBrace);
    if (commentClose === -1) {
      continue;
    }
    const jsonStr = body.slice(openBrace, commentClose).trim();
    try {
      return JSON.parse(jsonStr) as CodexReviewStateJson;
    } catch {
      // Fall through on malformed state
    }
  }
  return null;
}

function parseCodexSeverity(body: string): Severity {
  if (/P0\b|P0 Badge|critical|blocker/i.test(body)) {
    return "BLOCKER";
  }
  if (/P1\b|P1 Badge|high/i.test(body)) {
    return "HIGH";
  }
  if (/P2\b|P2 Badge|medium/i.test(body)) {
    return "MEDIUM";
  }
  if (/P3\b|P3 Badge|low/i.test(body)) {
    return "LOW";
  }
  return "MEDIUM";
}

function extractCodexTitle(body: string, path: string | null, line: number | null): string {
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
  return path && line ? `Codex finding on ${path}:${line}` : "Codex finding";
}

/**
 * Normalizes OpenAI Codex connector state markers and inline findings.
 *
 * @param input Pull request collection data.
 * @returns Normalized reviewer execution record for Codex.
 */
export function normalizeCodexReviewer(input: NormalizerInput): ReviewerExecutionRecord {
  const { headSha } = input;
  const stateJson = parseCodexState(input);
  const threads =
    input.reviewThreads?.filter((t) => {
      const firstComment = t.comments[0];
      return firstComment ? isCodexAuthor(firstComment.authorLogin) : false;
    }) ?? [];

  const evaluatedCommitSha = stateJson?.code_review?.commit_sha ?? null;
  const isFresh = evaluatedCommitSha !== null && evaluatedCommitSha === headSha;

  const findings: NormalizedFinding[] = [];
  for (const thread of threads) {
    const firstComment = thread.comments[0];
    if (!firstComment) {
      continue;
    }

    const severity = parseCodexSeverity(firstComment.body);
    const isBlocking =
      !thread.isResolved &&
      (severity === "BLOCKER" || severity === "HIGH" || severity === "MEDIUM");

    const finding: NormalizedFinding = {
      id: thread.id,
      reviewerId: "chatgpt-codex-connector",
      threadId: thread.id,
      title: extractCodexTitle(firstComment.body, thread.path, thread.line ?? thread.originalLine),
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

  if (!stateJson && threads.length === 0) {
    status = "PENDING";
    verdict = "NONE";
  } else if (evaluatedCommitSha !== null && !isFresh) {
    status = "STALE";
    verdict = "NONE";
  } else if (stateJson?.code_review?.status === "in_progress") {
    status = "PENDING";
    verdict = "NONE";
  } else if (stateJson?.code_review?.status === "failed") {
    status = "FAILED";
    verdict = "CHANGES_REQUESTED";
  } else if (stateJson?.code_review?.status === "completed") {
    status = "COMPLETED";
    const hasUnresolvedFindings =
      stateJson.code_review.has_unresolved_findings === true ||
      findings.some((f) => f.isBlocking && !f.isResolved);
    if (hasUnresolvedFindings) {
      verdict = "CHANGES_REQUESTED";
    } else {
      verdict = "APPROVE";
    }
  }

  return {
    reviewerId: "chatgpt-codex-connector",
    reviewerName: "Codex Reviewer",
    status,
    evaluatedCommitSha,
    isFresh,
    verdict,
    findings,
    checkRunConclusion: null,
  };
}

/**
 * Adapter export for Codex reviewer normalizer.
 */
export const codexNormalizer: ReviewerNormalizer = {
  reviewerId: "chatgpt-codex-connector",
  reviewerName: "Codex Reviewer",
  normalize: normalizeCodexReviewer,
};
