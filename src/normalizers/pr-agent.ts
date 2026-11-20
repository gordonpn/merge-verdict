import { z } from "zod";
import type { GitHubConversationComment } from "../collector/github-collector.js";
import type { NormalizedFinding } from "../models/finding.js";
import type { ReviewerExecutionRecord, ReviewerStatus } from "../models/reviewer.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";
import { stripMarkdownPunctuation } from "./utils.js";

const PR_AGENT_LOGINS = new Set(["github-actions", "github-actions[bot]"]);
const PR_AGENT_CHECK_NAMES = new Set(["runner / pr-agent", "pr-agent", "pr agent"]);
const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
const STATE_MARKER = "<!-- pr-agent-review-state:v1";
const StateSchema = z.object({
  schema_version: z.literal(1),
  last_run: z.object({ head_sha: z.string().regex(/^[a-f0-9]{40}$/i), complete: z.boolean() }),
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

function parseState(body: string): z.infer<typeof StateSchema> | undefined {
  const start = body.indexOf(STATE_MARKER);
  if (start < 0) return undefined;
  const end = body.indexOf("-->", start + STATE_MARKER.length);
  if (end < 0) return undefined;
  try {
    const value: unknown = JSON.parse(body.slice(start + STATE_MARKER.length, end));
    const parsed = StateSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
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

function ticketFindings(body: string, commentId: number): NormalizedFinding[] {
  const section = body.split(/Ticket compliance analysis/i)[1]?.split(/<\/td>|\n## /)[0];
  if (!section) return [];
  const findings: NormalizedFinding[] = [];
  let nonCompliant = false;
  for (const line of section.split("\n")) {
    const clean = stripMarkdownPunctuation(line).trim();
    if (/^Non-compliant requirements:?$/i.test(clean)) {
      nonCompliant = true;
      continue;
    }
    if (
      /^(?:Compliant requirements|Requires further human verification)/i.test(clean) ||
      clean.startsWith("[")
    ) {
      nonCompliant = false;
      continue;
    }
    const text = extractListItemText(line);
    if (!nonCompliant || !text || /^(?:none\.?|n\/a)$/i.test(text)) continue;
    findings.push({
      id: `pr-agent-${commentId}-ticket-${findings.length + 1}`,
      reviewerId: "pr-agent",
      title: text.slice(0, 120),
      description: text,
      severity: "HIGH",
      isBlocking: true,
      isResolved: false,
    });
  }
  return findings;
}

function commentTime(comment: GitHubConversationComment): number {
  const parsed = Date.parse(comment.updatedAt ?? comment.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Normalizes PR-Agent comments and workflow checks into a reviewer execution record.
 *
 * @param input Pull request collection data.
 * @returns Normalized reviewer execution record for PR-Agent.
 */
export function normalizePrAgentReviewer(input: NormalizerInput): ReviewerExecutionRecord {
  const comment = input.conversationComments
    ?.filter(
      (c) =>
        c.authorLogin !== null &&
        PR_AGENT_LOGINS.has(c.authorLogin.toLowerCase()) &&
        (c.body?.includes(REVIEW_MARKER) || c.body?.includes(STATE_MARKER)),
    )
    .sort((a, b) => commentTime(b) - commentTime(a) || b.id - a.id)[0];
  const check = input.checkRuns
    ?.filter((c) => PR_AGENT_CHECK_NAMES.has(c.name.toLowerCase()))
    .sort((a, b) => b.id - a.id)[0];
  const body = comment?.body ?? "";
  const state = parseState(body);
  const header = body.match(
    /Review updated until commit\s+https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/commit\/([a-f0-9]{40})\b/i,
  );
  const headerSha =
    header?.[1] && input.repository && header[1].toLowerCase() === input.repository.toLowerCase()
      ? header[2]
      : undefined;
  const sha = body.includes(STATE_MARKER) ? state?.last_run.head_sha : headerSha;
  const normalizedHeadSha = input.headSha.toLowerCase();
  const fresh = sha !== undefined && sha.toLowerCase() === normalizedHeadSha;
  const isStaleComment = sha !== undefined && !fresh;
  const findings: NormalizedFinding[] =
    comment && !isStaleComment ? ticketFindings(body, comment.id) : [];
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
  const checkMatchesHead =
    check !== undefined && check.commitSha.toLowerCase() === normalizedHeadSha;
  if (check && (!fresh || checkMatchesHead)) {
    evaluatedCommitSha = check.commitSha;
    if (!checkMatchesHead) status = "STALE";
    else if (check.status !== "completed") status = "PENDING";
    else if (
      check.conclusion === "failure" ||
      check.conclusion === "cancelled" ||
      check.conclusion === "timed_out" ||
      check.conclusion === "action_required" ||
      check.conclusion === null
    )
      status = "FAILED";
    else if (!fresh) status = "SKIPPED";
  }
  return {
    reviewerId: "pr-agent",
    reviewerName: "PR-Agent",
    status,
    evaluatedCommitSha,
    isFresh: evaluatedCommitSha !== null && evaluatedCommitSha.toLowerCase() === normalizedHeadSha,
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
