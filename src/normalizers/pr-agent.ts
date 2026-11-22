import { z } from "zod";
import type { GitHubConversationComment } from "../collector/github-collector.js";
import { digestCommentBody } from "../collector/pr-agent-provenance.js";
import type { NormalizedFinding } from "../models/finding.js";
import type { ReviewerExecutionRecord, ReviewerStatus } from "../models/reviewer.js";
import { canonicalizeCommitSha } from "../models/snapshot.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { stripMarkdownPunctuation } from "./utils.js";

const PR_AGENT_LOGINS = new Set(["github-actions", "github-actions[bot]"]);
const PR_AGENT_CHECK_NAMES = new Set(["runner / pr-agent", "pr-agent", "pr agent"]);
const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
const STATE_MARKER = "<!-- pr-agent-review-state:v1";
const StateSchema = z.object({
  schema_version: z.literal(1),
  last_run: z.object({
    head_sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/i)
      .transform((sha) => canonicalizeCommitSha(sha)),
    complete: z.boolean(),
  }),
  findings: z.array(
    z.object({
      finding_id: z.string().min(1),
      body: z.string(),
      path: z.string().nullish(),
      line_start: z.number().int().nullish(),
      state: z.string(),
    }),
  ),
});

interface StateCommentSpan {
  readonly start: number;
  readonly commentEnd: number | undefined;
  readonly state: z.infer<typeof StateSchema> | undefined;
}

interface AnalyzedPrAgentComment {
  readonly comment: GitHubConversationComment;
  readonly body: string;
  readonly stateSpan: StateCommentSpan | undefined;
  readonly state: z.infer<typeof StateSchema> | undefined;
  readonly sha: string | undefined;
  readonly fresh: boolean;
}

function skipAsciiWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor] ?? "")) {
    cursor++;
  }
  return cursor;
}

function scanJsonObjectEnd(
  text: string,
  jsonStart: number,
): { readonly jsonEnd?: number; readonly fallbackEnd?: number } {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { jsonEnd: i + 1 };
      }
    } else if (text.startsWith("-->", i)) {
      return { fallbackEnd: i + 3 };
    }
  }

  return {};
}

function scanStateComment(body: string): StateCommentSpan | undefined {
  const start = body.indexOf(STATE_MARKER);
  if (start < 0) return undefined;
  const cursor = skipAsciiWhitespace(body, start + STATE_MARKER.length);
  if (body[cursor] !== "{") {
    const closeIndex = body.indexOf("-->", cursor);
    return {
      start,
      commentEnd: closeIndex >= 0 ? closeIndex + 3 : undefined,
      state: undefined,
    };
  }

  const { jsonEnd, fallbackEnd } = scanJsonObjectEnd(body, cursor);
  if (jsonEnd === undefined) {
    return { start, commentEnd: fallbackEnd, state: undefined };
  }

  const afterJson = skipAsciiWhitespace(body, jsonEnd);
  if (!body.startsWith("-->", afterJson)) {
    const closeIndex = body.indexOf("-->", afterJson);
    return {
      start,
      commentEnd: closeIndex >= 0 ? closeIndex + 3 : undefined,
      state: undefined,
    };
  }

  try {
    const value: unknown = JSON.parse(body.slice(cursor, jsonEnd));
    const parsed = StateSchema.safeParse(value);
    return {
      start,
      commentEnd: afterJson + 3,
      state: parsed.success ? parsed.data : undefined,
    };
  } catch {
    return {
      start,
      commentEnd: afterJson + 3,
      state: undefined,
    };
  }
}

function extractListItemText(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    const text = trimmed.slice(2).trim();
    return text.length > 0 ? text : undefined;
  }
  const dotIndex = trimmed.indexOf(". ");
  if (dotIndex > 0 && dotIndex <= 3 && /^\d+$/.test(trimmed.slice(0, dotIndex))) {
    const text = trimmed.slice(dotIndex + 2).trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function ticketFindings(
  body: string,
  commentId: number,
  stateSpan: StateCommentSpan | undefined,
): NormalizedFinding[] {
  // State JSON is a separate artifact, not visible ticket-compliance Markdown.
  const markdown =
    stateSpan === undefined
      ? body
      : body.slice(0, stateSpan.start) +
        (stateSpan.commentEnd === undefined ? "" : body.slice(stateSpan.commentEnd));
  const afterHeading = markdown.split(/Ticket compliance analysis/i)[1];
  if (!afterHeading) return [];
  const section = afterHeading.split(/<\/td\s*>|<\/table\s*>|\r?\n[ \t]*## /i)[0];
  if (!section) return [];

  const items: string[] = [];
  let nonCompliant = false;
  let inItem = false;

  for (const line of section.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      inItem = false;
      continue;
    }

    const clean = stripMarkdownPunctuation(line).trim();
    if (/^Non-compliant requirements:?$/i.test(clean)) {
      nonCompliant = true;
      inItem = false;
      continue;
    }
    if (/^(?:Compliant requirements|Requires further human verification)\b:?/i.test(clean)) {
      nonCompliant = false;
      inItem = false;
      continue;
    }

    const text = extractListItemText(line);
    if (text !== undefined) {
      if (!nonCompliant || /^(?:none\.?|n\/a)$/i.test(text)) {
        inItem = false;
        continue;
      }
      items.push(text);
      inItem = true;
      continue;
    }

    const isTicketHeading =
      trimmed.startsWith("**[") ||
      /^#{1,6}\s+\[/.test(trimmed) ||
      /^\[[^\]]+\]\([^)]+\)\s*[-:]\s*(?:PR Code Verified|Partially compliant|Not compliant|Compliant)/i.test(
        clean,
      ) ||
      (!inItem && clean.startsWith("["));
    if (isTicketHeading) {
      nonCompliant = false;
      inItem = false;
      continue;
    }

    if (nonCompliant && inItem) {
      const lastIndex = items.length - 1;
      if (lastIndex >= 0) {
        items[lastIndex] = `${items[lastIndex]} ${trimmed}`;
      }
    }
  }

  return items.map((description, index) => ({
    id: `pr-agent-${commentId}-ticket-${index + 1}`,
    reviewerId: "pr-agent",
    title: description.slice(0, 120),
    description,
    severity: "HIGH",
    isBlocking: true,
    isResolved: false,
  }));
}

function commentTime(comment: GitHubConversationComment): number {
  const parsed = Date.parse(comment.updatedAt ?? comment.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function analyzeComment(
  comment: GitHubConversationComment,
  repository: string | undefined,
  normalizedHeadSha: string,
): AnalyzedPrAgentComment {
  const body = comment.body ?? "";
  const stateSpan = scanStateComment(body);
  const state = stateSpan?.state;
  const header = body.match(
    /Review updated until commit\s+https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/commit\/([a-f0-9]{40})\b/i,
  );
  const headerSha =
    header?.[1] && repository && header[1].toLowerCase() === repository.toLowerCase()
      ? canonicalizeCommitSha(header[2] ?? "")
      : undefined;
  const sha = body.includes(STATE_MARKER) ? state?.last_run.head_sha : headerSha;
  const fresh = sha !== undefined && sha === normalizedHeadSha;

  return { comment, body, stateSpan, state, sha, fresh };
}

/**
 * Normalizes PR-Agent comments and workflow checks into a reviewer execution record.
 *
 * @param input Pull request collection data.
 * @returns Normalized reviewer execution record for PR-Agent.
 */
export function normalizePrAgentReviewer(input: NormalizerInput): ReviewerExecutionRecord {
  const normalizedHeadSha = canonicalizeCommitSha(input.headSha);
  const candidates = (input.conversationComments ?? [])
    .filter(
      (c) =>
        c.authorLogin !== null &&
        PR_AGENT_LOGINS.has(c.authorLogin.toLowerCase()) &&
        (c.body?.includes(REVIEW_MARKER) || c.body?.includes(STATE_MARKER)),
    )
    .sort((a, b) => commentTime(b) - commentTime(a) || b.id - a.id)
    .map((c) => analyzeComment(c, input.repository, normalizedHeadSha));

  const provenance = input.prAgentProvenance;
  const provenanceProvided = provenance !== undefined;
  const verifiedProvenance =
    provenance?.status === "verified" &&
    provenance.commentId !== null &&
    provenance.bodyDigest !== null &&
    provenance.headSha !== null &&
    canonicalizeCommitSha(provenance.headSha) === normalizedHeadSha
      ? {
          commentId: provenance.commentId,
          bodyDigest: provenance.bodyDigest.toLowerCase(),
        }
      : null;

  const verifiedCandidate = verifiedProvenance
    ? candidates.find(
        (c) =>
          c.comment.id === verifiedProvenance.commentId &&
          (c.comment.bodyDigest ?? digestCommentBody(c.body)).toLowerCase() ===
            verifiedProvenance.bodyDigest,
      )
    : undefined;

  const provenCommentTrusted = provenanceProvided ? verifiedCandidate !== undefined : true;
  const selected = verifiedCandidate ?? candidates.find((c) => c.fresh) ?? candidates[0];
  const comment = selected?.comment;
  const body = selected?.body ?? "";
  const stateSpan = selected?.stateSpan;
  const state = selected?.state;
  const sha = selected?.sha;
  const fresh = selected?.fresh ?? false;
  const isStaleComment = sha !== undefined && !fresh;

  const check = input.checkRuns
    ?.filter((c) => {
      const name = c.name.toLowerCase();
      if (!PR_AGENT_CHECK_NAMES.has(name)) {
        return false;
      }
      if (name === "runner / pr-agent" && c.appSlug != null) {
        return c.appSlug.toLowerCase() === "github-actions";
      }
      return true;
    })
    .sort((a, b) => b.id - a.id)[0];

  const findings: NormalizedFinding[] =
    comment && !isStaleComment ? ticketFindings(body, comment.id, stateSpan) : [];
  if (!isStaleComment) {
    for (const finding of state?.findings ?? []) {
      const normalizedState = finding.state.toUpperCase();
      const resolved = normalizedState === "RESOLVED" || normalizedState === "FIXED";
      findings.push({
        id: `pr-agent-${finding.finding_id}`,
        reviewerId: "pr-agent",
        title:
          stripMarkdownPunctuation(finding.body.split("\n")[0] ?? "PR-Agent finding").slice(
            0,
            120,
          ) || "PR-Agent finding",
        description: finding.body,
        severity: "MEDIUM",
        isBlocking: !resolved,
        isResolved: resolved,
        ...(finding.path ? { filePath: finding.path } : {}),
        ...(finding.line_start && finding.line_start > 0 ? { lineNumber: finding.line_start } : {}),
      });
    }
  }

  let status: ReviewerStatus = sha ? (fresh ? "COMPLETED" : "STALE") : "PENDING";
  let evaluatedCommitSha = sha ?? null;
  if (fresh && state?.last_run.complete === false) status = "PENDING";
  if (provenanceProvided && !provenCommentTrusted && fresh) {
    status = "PENDING";
    evaluatedCommitSha = null;
  }
  const checkMatchesHead =
    check !== undefined && canonicalizeCommitSha(check.commitSha) === normalizedHeadSha;
  if (check && !isStaleComment && (!fresh || checkMatchesHead)) {
    evaluatedCommitSha = canonicalizeCommitSha(check.commitSha);
    if (!checkMatchesHead) status = "STALE";
    else if (check.status !== "completed") status = "PENDING";
    else if (!["success", "neutral", "skipped"].includes(check.conclusion ?? "")) status = "FAILED";
    else if (!fresh || (provenanceProvided && !provenCommentTrusted)) {
      // A successful workflow cannot establish missing or unverified review provenance.
      status = comment ? "PENDING" : "SKIPPED";
      if (comment) evaluatedCommitSha = null;
    }
  }

  return {
    reviewerId: "pr-agent",
    reviewerName: "PR-Agent",
    status,
    evaluatedCommitSha,
    isFresh:
      evaluatedCommitSha !== null &&
      canonicalizeCommitSha(evaluatedCommitSha) === normalizedHeadSha,
    verdict:
      status === "STALE"
        ? "NONE"
        : findings.some((f) => f.isBlocking && !f.isResolved)
          ? "CHANGES_REQUESTED"
          : status === "COMPLETED"
            ? "APPROVE"
            : "NONE",
    findings,
    checkRunConclusion: check?.conclusion ?? null,
  };
}

/**
 * Adapter export for PR-Agent reviewer normalizer.
 */
export const prAgentNormalizer: ReviewerNormalizer = {
  reviewerId: "pr-agent",
  reviewerName: "PR-Agent",
  normalize: normalizePrAgentReviewer,
};
