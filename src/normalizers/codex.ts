import { z } from "zod";
import type { NormalizedFinding } from "../models/finding.js";
import type {
  ReviewerExecutionRecord,
  ReviewerStatus,
  ReviewerVerdict,
} from "../models/reviewer.js";
import type { Severity } from "../models/severity.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { resolveThreadLineRange, stripMarkdownPunctuation } from "./utils.js";

const CODEX_LOGINS = new Set(["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"]);

const CodexReviewSectionSchema = z.object({
  commit_sha: z.string().nullish(),
  has_any_findings: z.boolean().nullish(),
  has_unresolved_findings: z.boolean().nullish(),
  status: z.string().nullish(),
});
const CodexReviewStateSchema = z.object({
  code_review: CodexReviewSectionSchema.nullish(),
  security_review: CodexReviewSectionSchema.nullish(),
});
type CodexReviewStateJson = z.infer<typeof CodexReviewStateSchema>;

interface ParsedCodexState {
  readonly state: CodexReviewStateJson;
  readonly rateLimited: boolean;
}

function isCodexAuthor(login: string | null): boolean {
  return login !== null && CODEX_LOGINS.has(login.toLowerCase());
}

// Canonical exclusion ordering for quota prose extraction:
// 1. Single-pass linear scan tracks Markdown fences and HTML comments together so neither
//    construct can prematurely close or hijack the other (fences ignore `<!--`, comments
//    ignore line-start ```` ``` ```` / `~~~`).
// 2. Removed fenced blocks and multi-line HTML comments emit `\n` so adjacent prose paragraphs
//    cannot merge across stripped blocks.
// 3. `stripExcludedHtmlElements` then runs on the result and unwinds misnested closing tags
//    to the innermost matching ancestor while failing closed to EOF when any tag stays open.
function stripMarkdownFencesAndHtmlComments(text: string): string {
  const chunks: string[] = [];
  const len = text.length;
  let fence = "";
  let i = 0;
  let lineEnd = -1;
  let nextLineStart = 0;

  while (i < len) {
    if (i >= nextLineStart) {
      lineEnd = text.indexOf("\n", i);
      nextLineStart = lineEnd === -1 ? len : lineEnd + 1;
    }

    if (fence) {
      const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
      const closingDelimiter = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line)?.[1];
      if (
        closingDelimiter &&
        closingDelimiter[0] === fence[0] &&
        closingDelimiter.length >= fence.length
      ) {
        fence = "";
        // Preserve paragraph separation between prose before and after a removed fence.
        chunks.push("\n");
      }
      i = nextLineStart;
      continue;
    }

    const atLineStart = i === 0 || text[i - 1] === "\n";
    if (atLineStart) {
      const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
      const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (delimiter) {
        fence = delimiter;
        i = nextLineStart;
        continue;
      }
    }

    const segment = text.slice(i, nextLineStart);
    const commentOffset = segment.indexOf("<!--");
    if (commentOffset === -1) {
      chunks.push(segment);
      i = nextLineStart;
      continue;
    }

    if (commentOffset > 0) {
      chunks.push(segment.slice(0, commentOffset));
    }

    const commentStart = i + commentOffset;
    const commentClose = text.indexOf("-->", commentStart + 4);
    if (commentClose === -1) {
      break;
    }

    if (lineEnd !== -1 && commentClose > lineEnd) {
      chunks.push("\n");
    }
    i = commentClose + 3;
  }

  return chunks.join("");
}

function stripExcludedHtmlElements(text: string): string {
  const tagPattern = /<(\/?)(pre|code|blockquote)\b[^>]*>/gi;
  const stack: string[] = [];
  let output = "";
  let cursor = 0;

  for (const match of text.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    const isClosing = match[1] === "/";
    const tagName = (match[2] ?? "").toLowerCase();

    if (!isClosing) {
      if (/\/\s*>$/.test(match[0])) {
        if (stack.length === 0) {
          output += text.slice(cursor, index);
          cursor = index + match[0].length;
        }
        continue;
      }
      if (stack.length === 0) {
        output += text.slice(cursor, index);
      }
      stack.push(tagName);
      continue;
    }

    const matchIndex = stack.lastIndexOf(tagName);
    if (matchIndex >= 0) {
      stack.length = matchIndex;
      if (stack.length === 0) {
        cursor = index + match[0].length;
      }
    }
  }

  // Unterminated excluded tags intentionally discard trailing text to EOF.
  if (stack.length === 0) {
    output += text.slice(cursor);
  }
  return output;
}

function hasCodexQuotaDiagnostic(body: string): boolean {
  const prose = stripExcludedHtmlElements(stripMarkdownFencesAndHtmlComments(body));
  return prose
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/^(?:[ \t\r]*\n)+/, ""))
    .some((paragraph) =>
      /^ {0,3}You have reached your Codex usage limits? for code reviews?\b/i.test(paragraph),
    );
}

function parseCodexState(input: NormalizerInput): ParsedCodexState | null {
  const eligibleComments = (input.conversationComments ?? []).filter((c) =>
    isCodexAuthor(c.authorLogin),
  );
  const eligibleReviews = (input.reviews ?? []).filter((r) => isCodexAuthor(r.reviewerLogin));
  const comments = [...eligibleComments, ...eligibleReviews];
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
      return null;
    }
    const commentClose = body.indexOf("-->", openBrace);
    if (commentClose === -1) {
      return null;
    }
    const jsonStr = body.slice(openBrace, commentClose).trim();
    try {
      const parsed = CodexReviewStateSchema.safeParse(JSON.parse(jsonStr));
      return parsed.success
        ? {
            state: parsed.data,
            rateLimited: hasCodexQuotaDiagnostic(body),
          }
        : null;
    } catch {
      return null;
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
  const parsedState = parseCodexState(input);
  const stateJson = parsedState?.state;
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
    const lineRange = resolveThreadLineRange(thread);

    const finding: NormalizedFinding = {
      id: thread.id,
      reviewerId: "chatgpt-codex-connector",
      threadId: thread.id,
      title: extractCodexTitle(firstComment.body, thread.path, lineRange.lineNumber ?? null),
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
    // Quota diagnostics must share the SHA-bearing state artifact.
    const rateLimited = isFresh && parsedState?.rateLimited === true;
    status = rateLimited ? "RATE_LIMITED" : "FAILED";
    verdict =
      rateLimited &&
      stateJson.code_review.has_unresolved_findings !== true &&
      !findings.some((finding) => finding.isBlocking && !finding.isResolved)
        ? "NONE"
        : "CHANGES_REQUESTED";
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
