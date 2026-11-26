const ISSUE_COMMENT_ARTIFACT_PREFIX_BY_WORKFLOW: ReadonlyMap<string, string> = new Map([
  [".github/workflows/pr-agent.yml", "pr-agent-review-provenance-pr-"],
  [".github/workflows/deepseek-review.yml", "deepseek-review-target-pr-"],
]);

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9][0-9]*$/;
const PULLS_LIST_PAGE_SIZE = 100;
const ARTIFACTS_LIST_PAGE_SIZE = 100;

/**
 * Pull request reference embedded in a `workflow_run` webhook payload.
 */
export interface WorkflowRunPullRequestRef {
  readonly number?: number | null | undefined;
}

/**
 * Repository coordinates embedded in a `workflow_run` webhook payload.
 */
export interface WorkflowRunRepositoryRef {
  readonly full_name?: string | null | undefined;
  readonly owner?:
    | {
        readonly login?: string | null | undefined;
      }
    | null
    | undefined;
}

/**
 * Subset of GitHub `workflow_run` webhook fields inspected during PR resolution.
 */
export interface WorkflowRunPayload {
  readonly id?: number | null | undefined;
  readonly event?: string | null | undefined;
  readonly path?: string | null | undefined;
  readonly head_sha?: string | null | undefined;
  readonly head_branch?: string | null | undefined;
  readonly head_repository?: WorkflowRunRepositoryRef | null | undefined;
  readonly repository?: WorkflowRunRepositoryRef | null | undefined;
  readonly pull_requests?:
    | readonly (WorkflowRunPullRequestRef | null | undefined)[]
    | null
    | undefined;
}

/**
 * Minimal pull request record returned by `rest.pulls.list`.
 */
export interface WorkflowRunResolverPullRequestItem {
  readonly number: number;
  readonly head?:
    | {
        readonly sha?: string | null | undefined;
        readonly repo?:
          | {
              readonly full_name?: string | null | undefined;
            }
          | null
          | undefined;
      }
    | null
    | undefined;
}

/**
 * Minimal artifact record returned by `rest.actions.listWorkflowRunArtifacts`.
 */
export interface WorkflowRunResolverArtifactItem {
  readonly name: string;
  readonly expired?: boolean | null | undefined;
}

/**
 * Narrow GitHub REST client contract required for `workflow_run` PR resolution.
 */
export interface WorkflowRunResolverRestClient {
  readonly pulls: {
    list(params: {
      readonly owner: string;
      readonly repo: string;
      readonly state: "open";
      readonly head: string;
      readonly per_page: number;
    }): Promise<{ readonly data: readonly WorkflowRunResolverPullRequestItem[] }>;
  };
  readonly actions: {
    listWorkflowRunArtifacts(params: {
      readonly owner: string;
      readonly repo: string;
      readonly run_id: number;
      readonly per_page?: number;
    }): Promise<{
      readonly data: {
        readonly artifacts: readonly WorkflowRunResolverArtifactItem[];
      };
    }>;
  };
}

/**
 * Parameters for resolving a pull request number from a `workflow_run` payload.
 */
export interface ResolveWorkflowRunPullRequestNumberInput {
  readonly owner: string;
  readonly repo: string;
  readonly workflowRun: WorkflowRunPayload | null | undefined;
  readonly rest: WorkflowRunResolverRestClient;
}

function parsePositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRepositoryFullName(
  rawFullName: unknown,
): { readonly owner: string; readonly repo: string; readonly fullName: string } | null {
  const fullName = normalizeNonEmptyString(rawFullName);
  if (fullName === null) {
    return null;
  }
  const parts = fullName.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [owner, repo] = parts;
  if (
    !owner ||
    !repo ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !REPO_SEGMENT_PATTERN.test(owner) ||
    !REPO_SEGMENT_PATTERN.test(repo)
  ) {
    return null;
  }
  return { owner, repo, fullName };
}

function resolveDirectPullRequestNumber(pullRequests: WorkflowRunPayload["pull_requests"]): {
  readonly handled: boolean;
  readonly pullRequestNumber: number | null;
} {
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) {
    return { handled: false, pullRequestNumber: null };
  }
  if (pullRequests.length > 1) {
    return { handled: true, pullRequestNumber: null };
  }
  return {
    handled: true,
    pullRequestNumber: parsePositiveSafeInteger(pullRequests[0]?.number),
  };
}

async function resolveForkPullRequestNumber(
  owner: string,
  repo: string,
  workflowRun: WorkflowRunPayload,
  rest: WorkflowRunResolverRestClient,
): Promise<number | null> {
  const headSha = normalizeNonEmptyString(workflowRun.head_sha);
  const headBranch = normalizeNonEmptyString(workflowRun.head_branch);
  const headRepo = parseRepositoryFullName(workflowRun.head_repository?.full_name);
  if (headSha === null || headBranch === null || headRepo === null) {
    return null;
  }

  const headOwnerLogin = normalizeNonEmptyString(workflowRun.head_repository?.owner?.login);
  if (headOwnerLogin !== null && headOwnerLogin.toLowerCase() !== headRepo.owner.toLowerCase()) {
    return null;
  }

  const { data: openPulls } = await rest.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${headRepo.owner}:${headBranch}`,
    per_page: PULLS_LIST_PAGE_SIZE,
  });

  const normalizedHeadSha = headSha.toLowerCase();
  const normalizedHeadRepo = headRepo.fullName.toLowerCase();
  const matchingPrNumbers = new Set<number>();

  for (const pr of openPulls) {
    const prNumber = parsePositiveSafeInteger(pr.number);
    const prHeadSha = normalizeNonEmptyString(pr.head?.sha);
    const prHeadRepo = normalizeNonEmptyString(pr.head?.repo?.full_name);
    if (
      prNumber !== null &&
      prHeadSha?.toLowerCase() === normalizedHeadSha &&
      prHeadRepo?.toLowerCase() === normalizedHeadRepo
    ) {
      matchingPrNumbers.add(prNumber);
    }
  }

  if (matchingPrNumbers.size !== 1) {
    return null;
  }
  return matchingPrNumbers.values().next().value ?? null;
}

async function resolveIssueCommentPullRequestNumber(
  owner: string,
  repo: string,
  workflowRun: WorkflowRunPayload,
  rest: WorkflowRunResolverRestClient,
): Promise<number | null> {
  const runId = parsePositiveSafeInteger(workflowRun.id);
  const workflowPath = normalizeNonEmptyString(workflowRun.path);
  const artifactPrefix =
    workflowPath !== null ? ISSUE_COMMENT_ARTIFACT_PREFIX_BY_WORKFLOW.get(workflowPath) : undefined;
  const runRepo = normalizeNonEmptyString(workflowRun.repository?.full_name);
  if (runId === null || artifactPrefix === undefined || runRepo === null) {
    return null;
  }

  const expectedRepo = `${owner}/${repo}`.toLowerCase();
  if (runRepo.toLowerCase() !== expectedRepo) {
    return null;
  }

  const headRepoRaw = workflowRun.head_repository?.full_name;
  if (headRepoRaw !== undefined && headRepoRaw !== null) {
    const headRepo = normalizeNonEmptyString(headRepoRaw);
    if (headRepo === null || headRepo.toLowerCase() !== expectedRepo) {
      return null;
    }
  }

  const { data } = await rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
    per_page: ARTIFACTS_LIST_PAGE_SIZE,
  });

  const matchedPrNumbers = new Set<number>();
  for (const artifact of data.artifacts) {
    if (artifact.expired === true || typeof artifact.name !== "string") {
      continue;
    }
    if (!artifact.name.startsWith(artifactPrefix)) {
      continue;
    }
    const suffix = artifact.name.slice(artifactPrefix.length);
    if (!POSITIVE_INTEGER_TEXT_PATTERN.test(suffix)) {
      continue;
    }
    const prNumber = parsePositiveSafeInteger(Number(suffix));
    if (prNumber !== null) {
      matchedPrNumbers.add(prNumber);
    }
  }

  if (matchedPrNumbers.size !== 1) {
    return null;
  }
  return matchedPrNumbers.values().next().value ?? null;
}

/**
 * Resolves a single unambiguous pull request number from a GitHub `workflow_run` payload.
 *
 * @param input Target repository coordinates, `workflow_run` payload, and REST client.
 * @returns Positive integer pull request number when uniquely resolved, otherwise `null`.
 */
export async function resolveWorkflowRunPullRequestNumber(
  input: ResolveWorkflowRunPullRequestNumberInput,
): Promise<number | null> {
  const owner = normalizeNonEmptyString(input.owner);
  const repo = normalizeNonEmptyString(input.repo);
  const workflowRun = input.workflowRun;
  if (owner === null || repo === null || workflowRun == null) {
    return null;
  }

  const directResult = resolveDirectPullRequestNumber(workflowRun.pull_requests);
  if (directResult.handled) {
    return directResult.pullRequestNumber;
  }

  const triggerEvent = normalizeNonEmptyString(workflowRun.event);
  if (triggerEvent === "pull_request") {
    return resolveForkPullRequestNumber(owner, repo, workflowRun, input.rest);
  }
  if (triggerEvent === "issue_comment") {
    return resolveIssueCommentPullRequestNumber(owner, repo, workflowRun, input.rest);
  }
  return null;
}
