import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { canonicalizeCommitSha } from "../models/snapshot.js";
import type { RetryRequest } from "./client.js";
import { extractZipEntryText } from "./zip.js";

const PR_AGENT_WORKFLOW_PATH = ".github/workflows/pr-agent.yml";
const PR_AGENT_ARTIFACT_NAME = "pr-agent-review-provenance";
const PR_AGENT_ARTIFACT_PREFIX = `${PR_AGENT_ARTIFACT_NAME}-pr-`;
const PR_AGENT_ARTIFACT_ENTRY = "pr-agent-provenance.json";
const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_WORKFLOW_RUNS_TO_INSPECT = 5;
const MAX_WORKFLOW_RUN_PAGES = 3;
const WORKFLOW_RUNS_PER_PAGE = 100;
const MAX_CANDIDATE_RUN_SCANS = 25;

export const PR_AGENT_CHECK_NAMES: ReadonlySet<string> = new Set([
  "runner / pr-agent",
  "pr-agent",
  "pr agent",
]);

/**
 * Checks whether a check run matches known PR-Agent job names from GitHub Actions.
 *
 * @param check Check run metadata with name and optional appSlug.
 * @returns True when the check name matches PR-Agent and any present appSlug is github-actions.
 */
export function isTrustedPrAgentCheckRun(check: {
  readonly name: string;
  readonly appSlug?: string | null;
}): boolean {
  if (!PR_AGENT_CHECK_NAMES.has(check.name.toLowerCase())) {
    return false;
  }
  return check.appSlug == null || check.appSlug.toLowerCase() === "github-actions";
}

const PrAgentProvenanceArtifactSchema = z.object({
  schema_version: z.literal(1),
  workflow_path: z.literal(PR_AGENT_WORKFLOW_PATH),
  run_id: z.number().int().positive(),
  run_attempt: z.number().int().positive().optional(),
  repository: z.string().min(1),
  pull_request_number: z.number().int().positive(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/i),
  comment_id: z.number().int().positive(),
  body_digest: z.string().regex(/^[a-f0-9]{64}$/i),
});

/**
 * Authenticated workflow-run and artifact provenance for a PR-Agent review comment.
 */
export interface PrAgentProvenanceEvidence {
  readonly status: "verified" | "unverified" | "unavailable";
  readonly workflowPath: string | null;
  readonly runId: number | null;
  readonly headSha: string | null;
  readonly commentId: number | null;
  readonly bodyDigest: string | null;
}

export interface CollectPrAgentProvenanceInput {
  readonly rest: Octokit;
  readonly retry: RetryRequest;
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly checkRunUrls: readonly (string | null)[];
  readonly commentDigests?: ReadonlyMap<number, string>;
}

function unavailableProvenance(): PrAgentProvenanceEvidence {
  return {
    status: "unavailable",
    workflowPath: null,
    runId: null,
    headSha: null,
    commentId: null,
    bodyDigest: null,
  };
}

function unverifiedProvenance(): PrAgentProvenanceEvidence {
  return {
    status: "unverified",
    workflowPath: null,
    runId: null,
    headSha: null,
    commentId: null,
    bodyDigest: null,
  };
}

function extractStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const record = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === "number") {
    return record.status;
  }
  if (typeof record.response?.status === "number") {
    return record.response.status;
  }
  return null;
}

function handleOptionalWorkflowError(error: unknown): boolean {
  const status = extractStatusCode(error);
  if (status === 401 || status === 403) {
    return true;
  }
  if (status === 404) {
    return false;
  }
  throw error;
}

function extractActionsRunId(detailsUrl: string | null): number | null {
  if (!detailsUrl) {
    return null;
  }
  const match = detailsUrl.match(
    /^https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:\/job\/\d+)?(?:[?#].*)?$/i,
  );
  if (!match?.[1]) {
    return null;
  }
  const runId = Number(match[1]);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

/**
 * Computes the canonical SHA-256 hex digest for a review comment body.
 *
 * @param body Comment markdown text.
 * @returns Lowercase SHA-256 hex digest.
 */
export function digestCommentBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function orderCheckRunIdsDesc(checkRunUrls: readonly (string | null)[]): number[] {
  const uniqueIds = new Set<number>();
  for (const detailsUrl of checkRunUrls) {
    const runId = extractActionsRunId(detailsUrl);
    if (runId !== null) {
      uniqueIds.add(runId);
    }
  }
  return [...uniqueIds].sort((a, b) => b - a);
}

function isCandidateArtifactForPr(artifactName: string, pullRequestNumber: number): boolean {
  return (
    artifactName === `${PR_AGENT_ARTIFACT_PREFIX}${pullRequestNumber}` ||
    artifactName === PR_AGENT_ARTIFACT_NAME
  );
}

function matchesCollectedComment(
  evidence: PrAgentProvenanceEvidence,
  commentDigests: ReadonlyMap<number, string> | undefined,
): boolean {
  if (!commentDigests) {
    return true;
  }
  return (
    evidence.commentId !== null &&
    evidence.bodyDigest !== null &&
    commentDigests.get(evidence.commentId) === evidence.bodyDigest
  );
}

interface ReadArtifactResult {
  readonly evidence: PrAgentProvenanceEvidence | null;
  readonly hasCandidateArtifact: boolean;
}

async function readRunProvenanceArtifact(
  rest: Octokit,
  retry: RetryRequest,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  canonicalHeadSha: string,
  runId: number,
): Promise<ReadArtifactResult> {
  const { data: artifactList } = await retry("list_workflow_run_artifacts", () =>
    rest.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: runId,
      per_page: 20,
    }),
  );

  const scopedArtifactName = `${PR_AGENT_ARTIFACT_PREFIX}${pullRequestNumber}`;
  const candidateArtifacts = artifactList.artifacts.filter(
    (artifact) => isCandidateArtifactForPr(artifact.name, pullRequestNumber) && !artifact.expired,
  );
  const provenanceArtifact =
    candidateArtifacts.find((artifact) => artifact.name === scopedArtifactName) ??
    candidateArtifacts[0];
  if (!provenanceArtifact) {
    return { evidence: null, hasCandidateArtifact: false };
  }

  let downloadResponse: Awaited<ReturnType<typeof rest.rest.actions.downloadArtifact>>;
  try {
    downloadResponse = await retry("download_pr_agent_provenance_artifact", () =>
      rest.rest.actions.downloadArtifact({
        owner,
        repo,
        artifact_id: provenanceArtifact.id,
        archive_format: "zip",
      }),
    );
  } catch (error) {
    if (extractStatusCode(error) === 410) {
      return { evidence: null, hasCandidateArtifact: true };
    }
    throw error;
  }

  const archiveBytes = toUint8Array(downloadResponse.data);
  if (!archiveBytes) {
    return { evidence: null, hasCandidateArtifact: true };
  }
  const jsonText = extractZipEntryText(archiveBytes, PR_AGENT_ARTIFACT_ENTRY, MAX_PROVENANCE_BYTES);
  if (!jsonText) {
    return { evidence: null, hasCandidateArtifact: true };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(jsonText);
  } catch {
    return { evidence: null, hasCandidateArtifact: true };
  }

  const parsed = PrAgentProvenanceArtifactSchema.safeParse(rawJson);
  if (!parsed.success) {
    return { evidence: null, hasCandidateArtifact: true };
  }

  const artifact = parsed.data;
  const expectedRepository = `${owner}/${repo}`.toLowerCase();
  if (
    artifact.run_id !== runId ||
    artifact.repository.toLowerCase() !== expectedRepository ||
    artifact.pull_request_number !== pullRequestNumber ||
    canonicalizeCommitSha(artifact.head_sha) !== canonicalHeadSha
  ) {
    return { evidence: null, hasCandidateArtifact: true };
  }

  return {
    evidence: {
      status: "verified",
      workflowPath: artifact.workflow_path,
      runId: artifact.run_id,
      headSha: canonicalHeadSha,
      commentId: artifact.comment_id,
      bodyDigest: artifact.body_digest.toLowerCase(),
    },
    hasCandidateArtifact: true,
  };
}

function runTimestampMs(run: {
  readonly updated_at?: string;
  readonly created_at?: string;
}): number {
  const parsed = Date.parse(run.updated_at ?? run.created_at ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Collects authenticated GitHub Actions workflow-run and artifact provenance for PR-Agent.
 *
 * @param input Collector context and check-run URLs.
 * @returns Provenance classification and attested comment metadata when available.
 */
export async function collectPrAgentProvenance(
  input: CollectPrAgentProvenanceInput,
): Promise<PrAgentProvenanceEvidence> {
  const { rest, retry, owner, repo, pullRequestNumber, checkRunUrls, commentDigests } = input;
  const canonicalHeadSha = canonicalizeCommitSha(input.headSha);
  const expectedRepository = `${owner}/${repo}`.toLowerCase();
  const inspectedRunIds = new Set<number>();
  interface CandidateWorkflowRun {
    readonly id: number;
    readonly headShaMatches: boolean;
    readonly timestampMs: number;
  }
  const candidateRuns: CandidateWorkflowRun[] = [];
  let fallbackUnavailable = false;
  let fallbackVerified: PrAgentProvenanceEvidence | null = null;

  for (const runId of orderCheckRunIdsDesc(checkRunUrls)) {
    if (inspectedRunIds.has(runId)) {
      continue;
    }

    try {
      const { data: run } = await retry("get_pr_agent_workflow_run", () =>
        rest.rest.actions.getWorkflowRun({ owner, repo, run_id: runId }),
      );
      if (
        run.path === PR_AGENT_WORKFLOW_PATH &&
        run.status === "completed" &&
        run.repository.full_name.toLowerCase() === expectedRepository
      ) {
        inspectedRunIds.add(run.id);
        const result = await readRunProvenanceArtifact(
          rest,
          retry,
          owner,
          repo,
          pullRequestNumber,
          canonicalHeadSha,
          run.id,
        );
        if (result.evidence) {
          if (matchesCollectedComment(result.evidence, commentDigests)) {
            return result.evidence;
          }
          fallbackVerified ??= result.evidence;
        }
      }
    } catch (error) {
      if (handleOptionalWorkflowError(error)) {
        fallbackUnavailable = true;
      }
    }
  }

  try {
    for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES; page++) {
      const { data: workflowRuns } = await retry("list_pr_agent_workflow_runs", () =>
        rest.rest.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: "pr-agent.yml",
          status: "completed",
          per_page: WORKFLOW_RUNS_PER_PAGE,
          page,
        }),
      );
      const runs = Array.isArray(workflowRuns?.workflow_runs) ? workflowRuns.workflow_runs : [];

      for (const run of runs) {
        if (
          Array.isArray(run.pull_requests) &&
          run.pull_requests.length > 0 &&
          !run.pull_requests.some((pr) => pr?.number === pullRequestNumber)
        ) {
          continue;
        }
        if (
          run.path === PR_AGENT_WORKFLOW_PATH &&
          run.repository.full_name.toLowerCase() === expectedRepository &&
          !inspectedRunIds.has(run.id)
        ) {
          inspectedRunIds.add(run.id);
          candidateRuns.push({
            id: run.id,
            headShaMatches:
              typeof run.head_sha === "string" &&
              canonicalizeCommitSha(run.head_sha) === canonicalHeadSha,
            timestampMs: runTimestampMs(run),
          });
        }
      }

      if (runs.length < WORKFLOW_RUNS_PER_PAGE) {
        break;
      }
    }
  } catch (error) {
    if (handleOptionalWorkflowError(error)) {
      return fallbackVerified ?? unavailableProvenance();
    }
  }

  candidateRuns.sort(
    (a, b) =>
      b.timestampMs - a.timestampMs ||
      Number(b.headShaMatches) - Number(a.headShaMatches) ||
      b.id - a.id,
  );

  let inspectedMatchingRuns = 0;
  for (const candidate of candidateRuns.slice(0, MAX_CANDIDATE_RUN_SCANS)) {
    try {
      const result = await readRunProvenanceArtifact(
        rest,
        retry,
        owner,
        repo,
        pullRequestNumber,
        canonicalHeadSha,
        candidate.id,
      );
      if (result.hasCandidateArtifact) {
        inspectedMatchingRuns += 1;
      }
      if (result.evidence) {
        if (matchesCollectedComment(result.evidence, commentDigests)) {
          return result.evidence;
        }
        fallbackVerified ??= result.evidence;
      }
      if (inspectedMatchingRuns >= MAX_WORKFLOW_RUNS_TO_INSPECT) {
        break;
      }
    } catch (error) {
      if (handleOptionalWorkflowError(error)) {
        fallbackUnavailable = true;
      }
    }
  }

  if (fallbackVerified) {
    return fallbackVerified;
  }

  if (fallbackUnavailable) {
    return unavailableProvenance();
  }

  return unverifiedProvenance();
}
