const ISSUE_COMMENT_ARTIFACT_PREFIX_BY_WORKFLOW: ReadonlyMap<string, string> = new Map([
  [".github/workflows/pr-agent.yml", "pr-agent-review-provenance-pr-"],
  [".github/workflows/deepseek-review.yml", "deepseek-review-target-pr-"],
]);

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9][0-9]*$/;
const PULLS_LIST_PAGE_SIZE = 100;
const ARTIFACTS_LIST_PAGE_SIZE = 100;
const MAX_CONNECTION_PAGES = 10;
const MAX_CONNECTION_ITEMS = 1000;

function skipLinkWhitespace(input: string, index: number): number {
  let pos = index;
  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) {
    pos += 1;
  }
  return pos;
}

function readLinkParamValue(
  input: string,
  index: number,
): { readonly value: string; readonly quoted: boolean; readonly nextIndex: number } | null {
  let pos = skipLinkWhitespace(input, index);
  if (input[pos] === '"') {
    pos += 1;
    let value = "";
    while (pos < input.length) {
      const ch = input[pos];
      if (ch === '"') {
        return { value, quoted: true, nextIndex: pos + 1 };
      }
      if (ch === "\\") {
        pos += 1;
        if (pos >= input.length) {
          return null;
        }
        value += input[pos];
        pos += 1;
        continue;
      }
      value += ch;
      pos += 1;
    }
    return null;
  }

  const start = pos;
  while (pos < input.length) {
    const ch = input[pos];
    if (ch === ";" || ch === "," || ch === " " || ch === "\t") {
      break;
    }
    if (ch === '"') {
      return null;
    }
    pos += 1;
  }
  return pos === start ? null : { value: input.slice(start, pos), quoted: false, nextIndex: pos };
}

function hasNextLinkRelation(linkHeader: string | undefined): boolean {
  if (!linkHeader) {
    return false;
  }
  let pos = skipLinkWhitespace(linkHeader, 0);
  while (pos < linkHeader.length) {
    if (linkHeader[pos] !== "<") {
      return false;
    }
    const uriEnd = linkHeader.indexOf(">", pos + 1);
    if (uriEnd === -1) {
      return false;
    }
    pos = skipLinkWhitespace(linkHeader, uriEnd + 1);
    let sawRel = false;
    let entryHasNext = false;

    while (pos < linkHeader.length && linkHeader[pos] !== ",") {
      if (linkHeader[pos] !== ";") {
        return false;
      }
      pos = skipLinkWhitespace(linkHeader, pos + 1);
      const nameStart = pos;
      while (pos < linkHeader.length) {
        const ch = linkHeader[pos];
        if (ch === "=" || ch === ";" || ch === "," || ch === " " || ch === "\t") {
          break;
        }
        pos += 1;
      }
      const paramName = linkHeader.slice(nameStart, pos).toLowerCase();
      if (paramName.length === 0) {
        return false;
      }
      pos = skipLinkWhitespace(linkHeader, pos);
      if (linkHeader[pos] === "=") {
        const parsed = readLinkParamValue(linkHeader, pos + 1);
        if (parsed === null) {
          return false;
        }
        pos = skipLinkWhitespace(linkHeader, parsed.nextIndex);
        // RFC 8288 Section 3.3 honors only the first rel parameter per link-value.
        if (paramName === "rel" && !sawRel) {
          sawRel = true;
          const tokens = parsed.quoted ? parsed.value.trim().split(/\s+/) : [parsed.value];
          entryHasNext = tokens.some((token) => token.toLowerCase() === "next");
        }
      }
    }

    if (entryHasNext) {
      return true;
    }
    if (pos >= linkHeader.length) {
      return false;
    }
    pos = skipLinkWhitespace(linkHeader, pos + 1);
  }
  return false;
}

interface ResolverPage<T> {
  readonly data: readonly T[];
  readonly headers?: { readonly link?: string };
}

/** Return all items, or null when pagination exceeds the page or item bounds. */
async function collectResolverPages<T>(
  readPage: (page: number) => Promise<ResolverPage<T>>,
): Promise<readonly T[] | null> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_CONNECTION_PAGES; page += 1) {
    const response = await readPage(page);
    if (items.length + response.data.length > MAX_CONNECTION_ITEMS) {
      return null;
    }
    items.push(...response.data);
    if (!hasNextLinkRelation(response.headers?.link)) {
      return items;
    }
    if (items.length >= MAX_CONNECTION_ITEMS) {
      return null;
    }
  }
  return null;
}

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
      readonly page?: number;
    }): Promise<ResolverPage<WorkflowRunResolverPullRequestItem>>;
  };
  readonly actions: {
    listWorkflowRunArtifacts(params: {
      readonly owner: string;
      readonly repo: string;
      readonly run_id: number;
      readonly per_page?: number;
      readonly page?: number;
    }): Promise<{
      readonly data: {
        readonly artifacts: readonly WorkflowRunResolverArtifactItem[];
      };
      readonly headers?: { readonly link?: string };
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

  const openPulls = await collectResolverPages((page) =>
    rest.pulls.list({
      owner,
      repo,
      state: "open",
      head: `${headRepo.owner}:${headBranch}`,
      per_page: PULLS_LIST_PAGE_SIZE,
      ...(page > 1 ? { page } : {}),
    }),
  );
  if (openPulls === null) {
    return null;
  }

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

  const artifacts = await collectResolverPages(async (page) => {
    const response = await rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: runId,
      per_page: ARTIFACTS_LIST_PAGE_SIZE,
      ...(page > 1 ? { page } : {}),
    });
    return {
      data: response.data.artifacts,
      ...(response.headers ? { headers: response.headers } : {}),
    };
  });
  if (artifacts === null) {
    return null;
  }

  const matchedPrNumbers = new Set<number>();
  for (const artifact of artifacts) {
    if (artifact.expired !== false || typeof artifact.name !== "string") {
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

  const expectedRepo = `${owner}/${repo}`.toLowerCase();
  const rawRunRepo = workflowRun.repository?.full_name;
  if (rawRunRepo !== undefined && rawRunRepo !== null) {
    const runRepo = normalizeNonEmptyString(rawRunRepo);
    if (runRepo === null || runRepo.toLowerCase() !== expectedRepo) {
      return null;
    }
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
