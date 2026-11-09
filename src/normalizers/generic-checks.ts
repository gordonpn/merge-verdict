import type { GitHubCheckRun, GitHubCommitStatus } from "../collector/github-collector.js";
import type { CheckRunConclusion, CheckRunRecord, CheckRunStatus } from "../models/check-run.js";

function isValidUrl(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function toCheckRunStatus(status: string): CheckRunStatus {
  if (status === "completed" || status === "in_progress" || status === "queued") {
    return status;
  }
  return "in_progress";
}

function normalizeStatusState(state: string): {
  status: CheckRunStatus;
  conclusion: CheckRunConclusion | null;
} {
  if (state === "success") {
    return { status: "completed", conclusion: "success" };
  }
  if (state === "failure" || state === "error") {
    return { status: "completed", conclusion: "failure" };
  }
  return { status: "in_progress", conclusion: null };
}

/**
 * Normalizes check runs and commit status fallbacks into structured check records.
 *
 * @param checkRuns Check run records collected from GitHub.
 * @param commitStatuses Commit status records collected from GitHub.
 * @returns Map of check names to normalized records.
 */
export function normalizeCheckRuns(
  checkRuns: readonly GitHubCheckRun[] = [],
  commitStatuses: readonly GitHubCommitStatus[] = [],
): Record<string, CheckRunRecord> {
  const result: Record<string, CheckRunRecord> = {};

  for (const check of checkRuns) {
    const record: CheckRunRecord = {
      name: check.name,
      status: toCheckRunStatus(check.status),
      conclusion: check.conclusion as CheckRunConclusion | null,
      commitSha: check.commitSha,
    };
    if (isValidUrl(check.detailsUrl)) {
      record.detailsUrl = check.detailsUrl;
    }
    result[check.name] = record;
  }

  for (const status of commitStatuses) {
    if (result[status.context]) {
      continue;
    }
    const { status: normalizedStatus, conclusion } = normalizeStatusState(status.state);
    const record: CheckRunRecord = {
      name: status.context,
      status: normalizedStatus,
      conclusion,
      commitSha: status.commitSha,
    };
    if (isValidUrl(status.targetUrl)) {
      record.detailsUrl = status.targetUrl;
    }
    result[status.context] = record;
  }

  return result;
}
