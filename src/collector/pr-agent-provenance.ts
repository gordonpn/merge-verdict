import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { canonicalizeCommitSha } from "../models/snapshot.js";
import type { RetryRequest } from "./client.js";
import { extractZipEntryText } from "./zip.js";

const PR_AGENT_WORKFLOW_PATH = ".github/workflows/pr-agent.yml";
const PR_AGENT_ARTIFACT_NAME = "pr-agent-review-provenance";
const PR_AGENT_ARTIFACT_ENTRY = "pr-agent-provenance.json";
const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_WORKFLOW_RUNS_TO_INSPECT = 5;

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

function isPermissionDenied(error: unknown): boolean {
  const status = extractStatusCode(error);
  return status === 401 || status === 403;
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

async function readRunProvenanceArtifact(
  rest: Octokit,
  retry: RetryRequest,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  canonicalHeadSha: string,
  runId: number,
): Promise<PrAgentProvenanceEvidence | null> {
  const { data: artifactList } = await retry("list_workflow_run_artifacts", () =>
    rest.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: runId,
      per_page: 20,
    }),
  );

  const provenanceArtifact = artifactList.artifacts.find(
    (artifact) => artifact.name === PR_AGENT_ARTIFACT_NAME && !artifact.expired,
  );
  if (!provenanceArtifact) {
    return null;
  }

  const downloadResponse = await retry("download_pr_agent_provenance_artifact", () =>
    rest.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: provenanceArtifact.id,
      archive_format: "zip",
    }),
  );

  const archiveBytes = toUint8Array(downloadResponse.data);
  if (!archiveBytes) {
    return null;
  }
  const jsonText = extractZipEntryText(archiveBytes, PR_AGENT_ARTIFACT_ENTRY, MAX_PROVENANCE_BYTES);
  if (!jsonText) {
    return null;
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(jsonText);
  } catch {
    return null;
  }

  const parsed = PrAgentProvenanceArtifactSchema.safeParse(rawJson);
  if (!parsed.success) {
    return null;
  }

  const artifact = parsed.data;
  const expectedRepository = `${owner}/${repo}`.toLowerCase();
  if (
    artifact.run_id !== runId ||
    artifact.repository.toLowerCase() !== expectedRepository ||
    artifact.pull_request_number !== pullRequestNumber ||
    canonicalizeCommitSha(artifact.head_sha) !== canonicalHeadSha
  ) {
    return null;
  }

  return {
    status: "verified",
    workflowPath: artifact.workflow_path,
    runId: artifact.run_id,
    headSha: canonicalHeadSha,
    commentId: artifact.comment_id,
    bodyDigest: artifact.body_digest.toLowerCase(),
  };
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
  const { rest, retry, owner, repo, pullRequestNumber, checkRunUrls } = input;
  const canonicalHeadSha = canonicalizeCommitSha(input.headSha);
  const expectedRepository = `${owner}/${repo}`.toLowerCase();
  const inspectedRunIds = new Set<number>();
  const candidateRunIds: number[] = [];
  let fallbackUnavailable = false;

  try {
    for (const detailsUrl of checkRunUrls) {
      const runId = extractActionsRunId(detailsUrl);
      if (runId === null || inspectedRunIds.has(runId)) {
        continue;
      }
      inspectedRunIds.add(runId);

      try {
        const { data: run } = await retry("get_pr_agent_workflow_run", () =>
          rest.rest.actions.getWorkflowRun({ owner, repo, run_id: runId }),
        );
        if (
          run.path === PR_AGENT_WORKFLOW_PATH &&
          run.status === "completed" &&
          run.repository.full_name.toLowerCase() === expectedRepository
        ) {
          const verified = await readRunProvenanceArtifact(
            rest,
            retry,
            owner,
            repo,
            pullRequestNumber,
            canonicalHeadSha,
            run.id,
          );
          if (verified) {
            return verified;
          }
        }
      } catch (error) {
        if (handleOptionalWorkflowError(error)) {
          fallbackUnavailable = true;
        }
      }
    }

    let listWorkflowRunsDenied = false;
    try {
      const { data: workflowRuns } = await retry("list_pr_agent_workflow_runs", () =>
        rest.rest.actions.listWorkflowRuns({
          owner,
          repo,
          workflow_id: "pr-agent.yml",
          status: "completed",
          per_page: 20,
        }),
      );

      for (const run of Array.isArray(workflowRuns?.workflow_runs)
        ? workflowRuns.workflow_runs
        : []) {
        if (
          run.path === PR_AGENT_WORKFLOW_PATH &&
          run.repository.full_name.toLowerCase() === expectedRepository &&
          !inspectedRunIds.has(run.id)
        ) {
          inspectedRunIds.add(run.id);
          candidateRunIds.push(run.id);
        }
      }
    } catch (error) {
      if (handleOptionalWorkflowError(error)) {
        listWorkflowRunsDenied = true;
      }
    }

    if (listWorkflowRunsDenied) {
      return unavailableProvenance();
    }

    for (const runId of candidateRunIds.slice(0, MAX_WORKFLOW_RUNS_TO_INSPECT)) {
      const verified = await readRunProvenanceArtifact(
        rest,
        retry,
        owner,
        repo,
        pullRequestNumber,
        canonicalHeadSha,
        runId,
      );
      if (verified) {
        return verified;
      }
    }

    if (fallbackUnavailable) {
      return unavailableProvenance();
    }
  } catch (error) {
    if (isPermissionDenied(error)) {
      return unavailableProvenance();
    }
    throw error;
  }

  return unverifiedProvenance();
}
