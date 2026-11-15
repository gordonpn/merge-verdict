import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { ReviewSnapshot } from "../models/index.js";
import type { PullRequestTarget } from "./approval-provider.js";
import { type CheckAnnotation, formatChecksReport } from "./checks-formatter.js";

export const DEFAULT_CHECK_NAME = "merge-verdict";
export const DEFAULT_OWNED_EXTERNAL_ID_PREFIX = "merge-verdict:";

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunPublishConclusion = "success" | "failure" | "action_required";
export type PublisherVerdict = "PASS" | "PENDING" | "FAIL" | "STALE" | "ERROR";

export type CheckState =
  | { readonly status: "in_progress"; readonly conclusion: null }
  | { readonly status: "completed"; readonly conclusion: CheckRunPublishConclusion };

export interface ExistingCheckRun {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly status: CheckRunStatus;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  readonly appId?: number | null;
  readonly externalId?: string | null;
  readonly annotationsCount?: number;
}

export interface PublishedCheckRun {
  readonly id: number;
  readonly htmlUrl: string;
  readonly status: CheckRunStatus;
  readonly conclusion: string | null;
}

export interface CheckRunOutputPayload {
  readonly title: string;
  readonly summary: string;
  readonly text: string;
  readonly annotations?: readonly CheckAnnotation[];
}

export interface CreateCheckRunParams {
  readonly owner: string;
  readonly repo: string;
  readonly name: string;
  readonly headSha: string;
  readonly status: CheckRunStatus;
  readonly conclusion: CheckRunPublishConclusion | null;
  readonly externalId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly output: CheckRunOutputPayload;
}

export interface UpdateCheckRunParams {
  readonly owner: string;
  readonly repo: string;
  readonly checkRunId: number;
  readonly status?: CheckRunStatus;
  readonly conclusion?: CheckRunPublishConclusion | null;
  readonly completedAt?: string;
  readonly output: CheckRunOutputPayload;
}

export interface ChecksClient {
  getHeadSha(target: PullRequestTarget): Promise<string>;
  listCheckRunsForRef(target: {
    owner: string;
    repo: string;
    ref: string;
    checkName: string;
  }): Promise<readonly ExistingCheckRun[]>;
  createCheckRun(params: CreateCheckRunParams): Promise<PublishedCheckRun>;
  updateCheckRun(params: UpdateCheckRunParams): Promise<PublishedCheckRun>;
  readonly ownedExternalIdPrefix?: string;
  isOwnedCheckRun(checkRun: ExistingCheckRun): boolean;
}

export interface OctokitChecksClientOptions {
  readonly expectedAppId?: number;
  readonly ownedExternalIdPrefix?: string;
}

export interface PublishCheckRunInput extends PullRequestTarget {
  readonly checkName?: string;
  readonly snapshot: ReviewSnapshot;
  readonly verdict: PublisherVerdict;
  readonly evaluatedAt: string;
  readonly requiredChecks: readonly string[];
  readonly getLatestStateFingerprint?: () => Promise<string>;
}

export interface PublishCheckRunResult {
  readonly action: "created" | "updated" | "skipped_newer_owner";
  readonly verdict: PublisherVerdict;
  readonly headSha: string;
  readonly status: CheckRunStatus;
  readonly conclusion: string | null;
  readonly checkRunId: number;
  readonly htmlUrl: string;
}

export interface PreSnapshotErrorReportInput extends PullRequestTarget {
  readonly headSha: string;
  readonly evaluatedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly verdict?: "ERROR" | "STALE";
}

export interface PublishErrorCheckRunInput extends PreSnapshotErrorReportInput {
  readonly checkName?: string;
}

const PreSnapshotErrorSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  evaluatedAt: z.string().max(40).datetime(),
  errorCode: z.string().min(1),
  errorMessage: z.string().min(1),
  verdict: z.enum(["ERROR", "STALE"]).optional(),
});

/**
 * Maps a verification verdict to the authoritative GitHub Checks API status and conclusion.
 * Never emits neutral or skipped conclusions.
 */
export function mapVerdictToCheckState(verdict: PublisherVerdict): CheckState {
  switch (verdict) {
    case "PASS":
      return { status: "completed", conclusion: "success" };
    case "PENDING":
      return { status: "in_progress", conclusion: null };
    case "FAIL":
    case "ERROR":
      return { status: "completed", conclusion: "failure" };
    case "STALE":
      return { status: "completed", conclusion: "action_required" };
  }
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let used = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8");
    if (used + size > maxBytes - 3) break;
    result += point;
    used += size;
  }
  return `${result}...`;
}

function escapeCell(value: string, maxBytes: number): string {
  return boundedUtf8(value, maxBytes)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[|`\\[\]*_~]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * Formats a bounded, escaped Checks API output payload for pre-snapshot failures
 * when no valid ReviewSnapshot could be constructed.
 */
export function formatPreSnapshotErrorReport(
  input: PreSnapshotErrorReportInput,
): CheckRunOutputPayload {
  const validated = PreSnapshotErrorSchema.parse(input);
  const verdict = validated.verdict ?? "ERROR";
  const safeRepo = escapeCell(`${validated.owner}/${validated.repo}`, 200);
  const safeHead = escapeCell(validated.headSha, 200);
  const safeCode = escapeCell(validated.errorCode, 200);
  const summaryCode = boundedUtf8(validated.errorCode, 200)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\r\n|\r|\n/g, " ");
  const safeMessage = escapeCell(validated.errorMessage, 2000);
  const text = `# Merge Verdict: ${verdict}\n\nRepository: ${safeRepo} PR #${validated.pullNumber}\n\nHead: ${safeHead}\n\nEvaluated at: ${validated.evaluatedAt}\n\n## Pre-snapshot failure\n\n| Code | Message |\n| --- | --- |\n| ${safeCode} | ${safeMessage} |\n`;
  return {
    title: `Merge Verdict: ${verdict}`,
    summary: `${verdict}: Pre-snapshot verification failed (${summaryCode}). Evaluated ${validated.evaluatedAt}.`,
    text: boundedUtf8(text, 60000),
  };
}

/**
 * Creates a ChecksClient backed by @octokit/rest.
 */
export function createOctokitChecksClient(
  octokit: Octokit,
  options: OctokitChecksClientOptions = {},
): ChecksClient {
  const api = octokit.rest ?? octokit;
  const externalIdPrefix = options.ownedExternalIdPrefix ?? DEFAULT_OWNED_EXTERNAL_ID_PREFIX;
  return {
    ownedExternalIdPrefix: externalIdPrefix,
    async getHeadSha(target) {
      const { data } = await api.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pullNumber,
      });
      return data.head.sha;
    },
    async listCheckRunsForRef(target) {
      const { data } = await api.checks.listForRef({
        owner: target.owner,
        repo: target.repo,
        ref: target.ref,
        check_name: target.checkName,
        per_page: 100,
      });
      return data.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        headSha: run.head_sha,
        status: run.status as CheckRunStatus,
        conclusion: run.conclusion ?? null,
        htmlUrl: run.html_url ?? "",
        appId: run.app?.id ?? null,
        externalId: run.external_id ?? null,
        annotationsCount: run.output?.annotations_count ?? 0,
      }));
    },
    async createCheckRun(params) {
      const { data } = await api.checks.create({
        owner: params.owner,
        repo: params.repo,
        name: params.name,
        head_sha: params.headSha,
        status: params.status,
        ...(params.conclusion !== null ? { conclusion: params.conclusion } : {}),
        ...(params.externalId !== undefined ? { external_id: params.externalId } : {}),
        ...(params.startedAt !== undefined ? { started_at: params.startedAt } : {}),
        ...(params.completedAt !== undefined ? { completed_at: params.completedAt } : {}),
        output: {
          title: params.output.title,
          summary: params.output.summary,
          text: params.output.text,
          ...(params.output.annotations !== undefined
            ? { annotations: [...params.output.annotations] }
            : {}),
        },
      });
      return {
        id: data.id,
        htmlUrl: data.html_url ?? "",
        status: data.status as CheckRunStatus,
        conclusion: data.conclusion ?? null,
      };
    },
    async updateCheckRun(params) {
      const { data } = await api.checks.update({
        owner: params.owner,
        repo: params.repo,
        check_run_id: params.checkRunId,
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.conclusion !== undefined && params.conclusion !== null
          ? { conclusion: params.conclusion }
          : {}),
        ...(params.completedAt !== undefined ? { completed_at: params.completedAt } : {}),
        output: {
          title: params.output.title,
          summary: params.output.summary,
          text: params.output.text,
          ...(params.output.annotations !== undefined
            ? { annotations: [...params.output.annotations] }
            : {}),
        },
      });
      return {
        id: data.id,
        htmlUrl: data.html_url ?? "",
        status: data.status as CheckRunStatus,
        conclusion: data.conclusion ?? null,
      };
    },
    isOwnedCheckRun(checkRun) {
      if (options.expectedAppId !== undefined) {
        if (checkRun.appId !== options.expectedAppId) return false;
        if (typeof checkRun.externalId === "string" && checkRun.externalId.length > 0) {
          return checkRun.externalId.startsWith(externalIdPrefix);
        }
        return true;
      }
      return (
        typeof checkRun.externalId === "string" && checkRun.externalId.startsWith(externalIdPrefix)
      );
    },
  };
}

function findLatestOwnedCheckRun(
  client: ChecksClient,
  runs: readonly ExistingCheckRun[],
  checkName: string,
  headSha: string,
): ExistingCheckRun | undefined {
  return [...runs]
    .filter(
      (run) => run.name === checkName && run.headSha === headSha && client.isOwnedCheckRun(run),
    )
    .sort((a, b) => b.id - a.id)[0];
}

function shouldSkipStaleOverwrite(
  existing: ExistingCheckRun | undefined,
): existing is ExistingCheckRun {
  if (existing === undefined) return false;
  return (
    existing.status === "in_progress" ||
    existing.conclusion === "failure" ||
    existing.conclusion === "action_required"
  );
}

// GitHub PATCH /check-runs/{id} appends annotations instead of replacing them,
// so any owned check run that already holds annotations must be superseded by a fresh run.
function canReuseCheckRun(existing: ExistingCheckRun | undefined): existing is ExistingCheckRun {
  return existing !== undefined && (existing.annotationsCount ?? 0) === 0;
}

/**
 * Publishes or updates the authoritative merge-verdict check run with pre-flight
 * head and fingerprint freshness verification, ownership filtering, and 50-item
 * annotation batching.
 */
export async function publishCheckRun(
  client: ChecksClient,
  input: PublishCheckRunInput,
): Promise<PublishCheckRunResult> {
  const checkName = input.checkName ?? DEFAULT_CHECK_NAME;
  const headSha = input.snapshot.headSha;
  const currentHeadSha = await client.getHeadSha({
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pullNumber,
  });
  let isFresh = currentHeadSha === headSha;
  if (isFresh) {
    if (input.getLatestStateFingerprint !== undefined) {
      const latestFingerprint = await input.getLatestStateFingerprint();
      isFresh = latestFingerprint === input.snapshot.stateFingerprint;
    } else if (input.verdict === "PASS") {
      isFresh = false;
    }
  }
  const effectiveVerdict: PublisherVerdict = isFresh ? input.verdict : "STALE";

  const existingRuns = await client.listCheckRunsForRef({
    owner: input.owner,
    repo: input.repo,
    ref: headSha,
    checkName,
  });
  const latestOwned = findLatestOwnedCheckRun(client, existingRuns, checkName, headSha);

  if (effectiveVerdict === "STALE" && shouldSkipStaleOverwrite(latestOwned)) {
    return {
      action: "skipped_newer_owner",
      verdict: "STALE",
      headSha,
      status: latestOwned.status,
      conclusion: latestOwned.conclusion,
      checkRunId: latestOwned.id,
      htmlUrl: latestOwned.htmlUrl,
    };
  }

  const report = formatChecksReport(input.snapshot, {
    verdict: effectiveVerdict,
    evaluatedAt: input.evaluatedAt,
    requiredChecks: input.requiredChecks,
  });
  const checkState = mapVerdictToCheckState(effectiveVerdict);
  const firstBatch = report.annotationBatches[0];
  const initialOutput: CheckRunOutputPayload =
    firstBatch !== undefined ? { ...report.output, annotations: firstBatch } : { ...report.output };

  const externalIdPrefix = client.ownedExternalIdPrefix ?? DEFAULT_OWNED_EXTERNAL_ID_PREFIX;
  const reusableOwned = canReuseCheckRun(latestOwned) ? latestOwned : undefined;
  let published: PublishedCheckRun;
  if (reusableOwned !== undefined) {
    published = await client.updateCheckRun({
      owner: input.owner,
      repo: input.repo,
      checkRunId: reusableOwned.id,
      status: checkState.status,
      conclusion: checkState.conclusion,
      ...(checkState.status === "completed" ? { completedAt: input.evaluatedAt } : {}),
      output: initialOutput,
    });
  } else {
    published = await client.createCheckRun({
      owner: input.owner,
      repo: input.repo,
      name: checkName,
      headSha,
      status: checkState.status,
      conclusion: checkState.conclusion,
      externalId: `${externalIdPrefix}${headSha}`,
      startedAt: input.evaluatedAt,
      ...(checkState.status === "completed" ? { completedAt: input.evaluatedAt } : {}),
      output: initialOutput,
    });
  }

  for (const batch of report.annotationBatches.slice(1)) {
    published = await client.updateCheckRun({
      owner: input.owner,
      repo: input.repo,
      checkRunId: published.id,
      output: {
        ...report.output,
        annotations: batch,
      },
    });
  }

  return {
    action: reusableOwned !== undefined ? "updated" : "created",
    verdict: effectiveVerdict,
    headSha,
    status: checkState.status,
    conclusion: checkState.conclusion,
    checkRunId: published.id,
    htmlUrl: published.htmlUrl,
  };
}

/**
 * Publishes a blocking check run when collection or base-branch policy parsing
 * fails prior to constructing a valid ReviewSnapshot.
 */
export async function publishErrorCheckRun(
  client: ChecksClient,
  input: PublishErrorCheckRunInput,
): Promise<PublishCheckRunResult> {
  const checkName = input.checkName ?? DEFAULT_CHECK_NAME;
  // A lookup failure cannot leave an evaluated, previously passing check green.
  // The authenticated evaluated SHA remains a safe target for blocking publication.
  let currentHeadSha = input.headSha;
  try {
    currentHeadSha = await client.getHeadSha({
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
    });
  } catch {
    // Preserve ERROR and continue through the existing ownership checks.
  }
  const effectiveVerdict: "ERROR" | "STALE" = currentHeadSha === input.headSha ? "ERROR" : "STALE";

  const existingRuns = await client.listCheckRunsForRef({
    owner: input.owner,
    repo: input.repo,
    ref: input.headSha,
    checkName,
  });
  const latestOwned = findLatestOwnedCheckRun(client, existingRuns, checkName, input.headSha);

  if (effectiveVerdict === "STALE" && shouldSkipStaleOverwrite(latestOwned)) {
    return {
      action: "skipped_newer_owner",
      verdict: "STALE",
      headSha: input.headSha,
      status: latestOwned.status,
      conclusion: latestOwned.conclusion,
      checkRunId: latestOwned.id,
      htmlUrl: latestOwned.htmlUrl,
    };
  }

  const output = formatPreSnapshotErrorReport({
    ...input,
    verdict: effectiveVerdict,
  });
  const checkState = mapVerdictToCheckState(effectiveVerdict);

  const externalIdPrefix = client.ownedExternalIdPrefix ?? DEFAULT_OWNED_EXTERNAL_ID_PREFIX;
  const reusableOwned = canReuseCheckRun(latestOwned) ? latestOwned : undefined;
  const published =
    reusableOwned !== undefined
      ? await client.updateCheckRun({
          owner: input.owner,
          repo: input.repo,
          checkRunId: reusableOwned.id,
          status: checkState.status,
          conclusion: checkState.conclusion,
          completedAt: input.evaluatedAt,
          output,
        })
      : await client.createCheckRun({
          owner: input.owner,
          repo: input.repo,
          name: checkName,
          headSha: input.headSha,
          status: checkState.status,
          conclusion: checkState.conclusion,
          externalId: `${externalIdPrefix}${input.headSha}`,
          startedAt: input.evaluatedAt,
          completedAt: input.evaluatedAt,
          output,
        });

  return {
    action: reusableOwned !== undefined ? "updated" : "created",
    verdict: effectiveVerdict,
    headSha: input.headSha,
    status: checkState.status,
    conclusion: checkState.conclusion,
    checkRunId: published.id,
    htmlUrl: published.htmlUrl,
  };
}
