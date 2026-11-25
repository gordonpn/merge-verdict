import { createHash } from "node:crypto";
import { GraphqlResponseError, graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import type { CheckRunConclusion, CheckRunStatus } from "../models/check-run.js";
import {
  type CollectorRetryOptions,
  createRetryRequest,
  type RetryRequest,
  withRestRetries,
} from "./client.js";
import {
  collectPrAgentProvenance,
  isTrustedPrAgentCheckRun,
  type PrAgentProvenanceEvidence,
} from "./pr-agent-provenance.js";
import CHANGED_FILES_QUERY from "./queries/changed-files.graphql?raw";
import THREAD_COMMENTS_QUERY from "./queries/review-thread-comments.graphql?raw";
import REVIEW_THREADS_QUERY from "./queries/review-threads.graphql?raw";

type GraphqlClient = typeof graphql;

const PAGE_SIZE = 100;
const MAX_CONNECTION_ITEMS = 1000;
const MAX_CONNECTION_PAGES = 10;
const POLICY_FILE_PATH = ".github/merge-verdict.yml";
const REVIEW_THREAD_COMMENT_CONCURRENCY = 5;

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

interface ReviewThreadCommentNode {
  readonly id: string;
  readonly body: string;
  readonly author: { readonly login: string } | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commit: { readonly oid: string } | null;
  readonly originalCommit?: { readonly oid: string } | null;
}

interface ReviewThreadCommentConnection {
  readonly nodes: ReviewThreadCommentNode[];
  readonly pageInfo: PageInfo;
}

interface ReviewThreadNode {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly resolvedBy: { readonly login: string } | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly comments: ReviewThreadCommentConnection;
}

interface ReviewThreadConnection {
  readonly nodes: ReviewThreadNode[];
  readonly pageInfo: PageInfo;
}

interface ReviewThreadsResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: ReviewThreadConnection;
    } | null;
  } | null;
}

interface ChangedFilesResponse {
  readonly repository: {
    readonly pullRequest: {
      readonly files: {
        readonly nodes: { readonly path: string }[];
        readonly pageInfo: PageInfo;
      };
    } | null;
  } | null;
}

interface ReviewThreadCommentsResponse {
  readonly node: {
    readonly comments?: ReviewThreadCommentConnection;
  } | null;
}

export type GitHubCollectorErrorKind = "rate_limit" | "api" | "network" | "policy";

/**
 * Identifies a failed GitHub API collection request.
 */
export class GitHubCollectorError extends Error {
  readonly kind: GitHubCollectorErrorKind;
  readonly status: number | null;

  constructor(
    kind: GitHubCollectorErrorKind,
    message: string,
    cause?: unknown,
    status: number | null = null,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitHubCollectorError";
    this.kind = kind;
    this.status = status;
  }
}

export interface CollectPullRequestInput {
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly evaluationSha?: string;
  /** Protected base commit used to load policy content; defaults to the pull request base SHA. */
  readonly policySha?: string;
  /** Repository-relative policy file path, loaded only from the protected base revision. */
  readonly configPath?: string;
  /** Collect GitHub Actions workflow-run and provenance-artifact evidence for PR-Agent. */
  readonly collectPrAgentProvenance?: boolean;
}

export interface GitHubCollectorOptions extends CollectorRetryOptions {
  /** Collect GitHub Actions workflow-run and provenance-artifact evidence for PR-Agent. */
  readonly collectPrAgentProvenance?: boolean;
}

export interface GitHubReviewThreadComment {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly bodyDigest: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  /** Revision matching originalLine and path; optional for existing callers and fixtures. */
  readonly originalCommitSha?: string | null;
  readonly commitSha: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitHubReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly resolvedByLogin: string | null;
  readonly isOutdated: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly comments: readonly GitHubReviewThreadComment[];
}

export interface GitHubConversationComment {
  readonly id: number;
  readonly authorLogin: string | null;
  readonly body: string | null;
  readonly bodyDigest: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export type GitHubReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING"
  | (string & {});

export type GitHubCommitStatusState = "error" | "failure" | "pending" | "success" | (string & {});

export type GitHubCheckRunStatus = CheckRunStatus | (string & {});

export type GitHubCheckRunConclusion = CheckRunConclusion | (string & {});

export interface GitHubReviewSubmission {
  readonly id: number;
  readonly reviewerLogin: string | null;
  readonly state: GitHubReviewState;
  readonly commitSha: string | null;
  readonly submittedAt: string | null;
  readonly body: string | null;
  readonly bodyDigest: string | null;
}

export interface GitHubCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: GitHubCheckRunStatus;
  readonly conclusion: GitHubCheckRunConclusion | null;
  readonly commitSha: string;
  readonly detailsUrl: string | null;
  readonly appSlug?: string | null;
  readonly output: {
    readonly title: string | null;
    readonly summary: string | null;
    readonly text: string | null;
  };
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface GitHubCommitStatus {
  readonly context: string;
  readonly state: GitHubCommitStatusState;
  readonly commitSha: string;
  readonly targetUrl: string | null;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Collected security metadata. Required fields may evolve before version 1.0;
 * typed consumers and fixtures must migrate with collector changes.
 * See docs/security.md for the isFork migration and fail-closed defaults.
 */
export interface GitHubPullRequestData {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  /** Untrusted PR description; absent on older serialized collector snapshots. */
  readonly body?: string | null;
  /** Verified reachable subset of headSha history, excluding headSha itself; not exhaustive. */
  readonly ancestorCommitShas?: readonly string[];
  readonly baseSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** Whether the head repository differs from the protected base repository. */
  readonly isFork: boolean;
  readonly isDraft: boolean;
  readonly mergeable: boolean | null;
  readonly authorLogin: string | null;
  readonly evaluationSha: string;
  readonly policyVersion: string;
  readonly changedFilePaths: readonly string[];
  readonly reviewThreads: readonly GitHubReviewThread[];
  readonly conversationComments: readonly GitHubConversationComment[];
  readonly reviews: readonly GitHubReviewSubmission[];
  readonly checkRuns: readonly GitHubCheckRun[];
  /** Most recent status for each context on the evaluation SHA. */
  readonly commitStatuses: readonly GitHubCommitStatus[];
  readonly prAgentProvenance?: PrAgentProvenanceEvidence;
  readonly policyContent: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getStatus(error: unknown): number | null {
  const record = asRecord(error);
  if (typeof record?.status === "number") {
    return record.status;
  }
  const response = asRecord(record?.response);
  if (typeof response?.status === "number") {
    return response.status;
  }
  return null;
}

const MAX_ERROR_CAUSE_DEPTH = 8;

function sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = /authorization|cookie|token|secret/i.test(key) ? "[REDACTED]" : value;
  }
  return sanitized;
}

function sanitizeErrorCause(error: unknown, seen: Set<object> = new Set(), depth = 0): unknown {
  if (typeof error !== "object" || error === null) {
    return error;
  }
  if (seen.has(error) || depth >= MAX_ERROR_CAUSE_DEPTH) {
    return undefined;
  }

  seen.add(error);
  const record = error as Record<string, unknown>;
  const req = asRecord(record.request);
  const reqHeaders = asRecord(req?.headers);
  const directHeaders = asRecord(record.headers);
  const nestedCause = record.cause;

  let updatedReq = req;
  if (reqHeaders !== null) {
    updatedReq = { ...req, headers: sanitizeHeaders(reqHeaders) };
  }

  let updatedDirectHeaders = directHeaders;
  if (directHeaders !== null) {
    updatedDirectHeaders = sanitizeHeaders(directHeaders);
  }

  const updatedCause =
    nestedCause === undefined ? undefined : sanitizeErrorCause(nestedCause, seen, depth + 1);

  if (
    updatedReq !== req ||
    updatedDirectHeaders !== directHeaders ||
    updatedCause !== nestedCause
  ) {
    const descriptors = Object.getOwnPropertyDescriptors(error);
    if (error instanceof Error) {
      descriptors.message = {
        value: error.message,
        writable: true,
        configurable: true,
        enumerable: false,
      };
      descriptors.stack = {
        value: error.stack,
        writable: true,
        configurable: true,
        enumerable: false,
      };
    }
    if (nestedCause !== undefined || descriptors.cause !== undefined) {
      descriptors.cause = {
        value: updatedCause,
        writable: true,
        configurable: true,
        enumerable: descriptors.cause?.enumerable ?? false,
      };
    }
    const clone = Object.create(Object.getPrototypeOf(error), descriptors) as Record<
      string,
      unknown
    >;
    if (updatedReq !== req) {
      clone.request = updatedReq;
    }
    if (updatedDirectHeaders !== directHeaders) {
      clone.headers = updatedDirectHeaders;
    }
    return clone;
  }

  return error;
}

function toCollectorError(error: unknown): GitHubCollectorError {
  if (error instanceof GitHubCollectorError) {
    return error;
  }

  const status = getStatus(error);
  const record = asRecord(error);
  const message = error instanceof Error ? error.message : "Unknown GitHub API error";
  const hasRateLimitErrorType =
    error instanceof GraphqlResponseError &&
    error.errors?.some((graphqlError) => graphqlError.type === "RATE_LIMITED");
  const isRateLimited = status === 429 || hasRateLimitErrorType || /rate limit/i.test(message);
  const hasResponse = error instanceof GraphqlResponseError || record?.response !== undefined;
  let kind: GitHubCollectorErrorKind;
  if (isRateLimited) {
    kind = "rate_limit";
  } else if (hasResponse) {
    kind = "api";
  } else {
    kind = "network";
  }

  return new GitHubCollectorError(kind, message, sanitizeErrorCause(error), status);
}

function digestBody(body: string): string;
function digestBody(body: string | null): string | null;
function digestBody(body: string | null): string | null {
  return body === null ? null : createHash("sha256").update(body).digest("hex");
}

function mapThreadComment(comment: ReviewThreadCommentNode): GitHubReviewThreadComment {
  return {
    id: comment.id,
    authorLogin: comment.author?.login ?? null,
    body: comment.body,
    bodyDigest: digestBody(comment.body),
    path: comment.path,
    line: comment.line,
    originalLine: comment.originalLine,
    commitSha: comment.commit?.oid ?? null,
    originalCommitSha: comment.originalCommit?.oid ?? null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function requireNextCursor(pageInfo: PageInfo, currentCursor: string | null): string {
  if (
    !pageInfo.hasNextPage ||
    pageInfo.endCursor === null ||
    pageInfo.endCursor === currentCursor
  ) {
    throw new GitHubCollectorError(
      "api",
      "GitHub returned a paginated connection without a new cursor.",
    );
  }
  return pageInfo.endCursor;
}

/** Fails collection rather than returning an incomplete verification snapshot. */
function checkPaginationBounds(
  operation: string,
  pages: number,
  items: number,
  hasNextPage: boolean,
): void {
  if (
    pages > MAX_CONNECTION_PAGES ||
    items > MAX_CONNECTION_ITEMS ||
    (hasNextPage && (pages >= MAX_CONNECTION_PAGES || items >= MAX_CONNECTION_ITEMS))
  ) {
    throw new GitHubCollectorError(
      "api",
      `Pagination limit exceeded for ${operation}: ${pages} pages, ${items} items, ` +
        `hasNextPage=${hasNextPage}; maximum ${MAX_CONNECTION_PAGES} pages or ${MAX_CONNECTION_ITEMS} items.`,
    );
  }
}

/** Octokit normalizes paginated REST payloads, including check_runs, into arrays. */
function boundedRestPages(operation: string) {
  let pages = 0;
  let items = 0;
  return <T>(response: {
    readonly data: T[];
    readonly headers: { readonly link?: string };
  }): T[] => {
    pages += 1;
    items += response.data.length;
    const hasNextPage = /<[^>]+>;\s*rel="next"/.test(response.headers.link ?? "");
    checkPaginationBounds(operation, pages, items, hasNextPage);
    return response.data;
  };
}

async function collectThreadComments(
  client: GraphqlClient,
  thread: ReviewThreadNode,
  retry: RetryRequest,
): Promise<GitHubReviewThreadComment[]> {
  const comments = thread.comments.nodes.map(mapThreadComment);
  let pageInfo = thread.comments.pageInfo;
  let pages = 1;
  checkPaginationBounds(
    `thread_comments:${thread.id}`,
    pages,
    comments.length,
    pageInfo.hasNextPage,
  );
  let cursor: string | null = null;

  while (pageInfo.hasNextPage) {
    const nextCursor = requireNextCursor(pageInfo, cursor);
    const page = await retry("thread_comments", () =>
      client<ReviewThreadCommentsResponse>(THREAD_COMMENTS_QUERY, {
        threadId: thread.id,
        cursor: nextCursor,
      }),
    );
    if (page.node === null || page.node.comments === undefined) {
      throw new GitHubCollectorError("api", "GitHub returned no review thread for a comment page.");
    }
    cursor = nextCursor;
    comments.push(...page.node.comments.nodes.map(mapThreadComment));
    pageInfo = page.node.comments.pageInfo;
    pages += 1;
    checkPaginationBounds(
      `thread_comments:${thread.id}`,
      pages,
      comments.length,
      pageInfo.hasNextPage,
    );
  }

  return comments;
}

async function collectReviewThreads(
  client: GraphqlClient,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  retry: RetryRequest,
): Promise<GitHubReviewThread[]> {
  const threads: GitHubReviewThread[] = [];
  let pages = 0;
  let cursor: string | null = null;

  while (true) {
    const data = await retry("review_threads", () =>
      client<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        number: pullRequestNumber,
        cursor,
      }),
    );
    const pullRequest = data.repository?.pullRequest;
    if (pullRequest === null || pullRequest === undefined) {
      throw new GitHubCollectorError("api", "GitHub returned no pull request review data.");
    }

    const connection = pullRequest.reviewThreads;
    pages += 1;
    checkPaginationBounds(
      "review_threads",
      pages,
      threads.length + connection.nodes.length,
      connection.pageInfo.hasNextPage,
    );
    for (
      let start = 0;
      start < connection.nodes.length;
      start += REVIEW_THREAD_COMMENT_CONCURRENCY
    ) {
      const batch = connection.nodes.slice(start, start + REVIEW_THREAD_COMMENT_CONCURRENCY);
      const mappedThreads = await Promise.all(
        batch.map(async (thread) => ({
          id: thread.id,
          isResolved: thread.isResolved,
          resolvedByLogin: thread.resolvedBy?.login ?? null,
          isOutdated: thread.isOutdated,
          path: thread.path,
          line: thread.line,
          originalLine: thread.originalLine,
          comments: await collectThreadComments(client, thread, retry),
        })),
      );
      threads.push(...mappedThreads);
    }

    if (!connection.pageInfo.hasNextPage) {
      return threads;
    }
    cursor = requireNextCursor(connection.pageInfo, cursor);
  }
}

async function collectChangedFilePaths(
  client: GraphqlClient,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  retry: RetryRequest,
): Promise<string[]> {
  const paths: string[] = [];
  let pages = 0;
  let cursor: string | null = null;

  while (true) {
    const data = await retry("changed_files", () =>
      client<ChangedFilesResponse>(CHANGED_FILES_QUERY, {
        owner,
        repo,
        number: pullRequestNumber,
        cursor,
      }),
    );
    const pullRequest = data.repository?.pullRequest;
    if (pullRequest === null || pullRequest === undefined) {
      throw new GitHubCollectorError("api", "GitHub returned no pull request file data.");
    }

    const connection = pullRequest.files;
    pages += 1;
    checkPaginationBounds(
      "changed_files",
      pages,
      paths.length + connection.nodes.length,
      connection.pageInfo.hasNextPage,
    );
    paths.push(...connection.nodes.map((file) => file.path));
    if (!connection.pageInfo.hasNextPage) {
      return paths;
    }
    cursor = requireNextCursor(connection.pageInfo, cursor);
  }
}

async function getPolicyContent(
  rest: Octokit,
  owner: string,
  repo: string,
  policySha: string,
  configPath: string,
): Promise<string> {
  try {
    const { data } = await rest.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
      ref: policySha,
    });
    if (Array.isArray(data)) {
      throw new GitHubCollectorError("api", "GitHub returned a directory.");
    }
    if (data.type !== "file") {
      throw new GitHubCollectorError("api", `GitHub returned type "${data.type}".`);
    }
    if (data.encoding !== "base64") {
      throw new GitHubCollectorError(
        "api",
        `GitHub returned encoding "${data.encoding}" at ${data.size} bytes.`,
      );
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    const collectorError = toCollectorError(error);
    const kind: GitHubCollectorErrorKind =
      collectorError.kind === "rate_limit" ? "rate_limit" : "policy";
    throw new GitHubCollectorError(
      kind,
      `Failed to read ${configPath} at ${policySha}: ${collectorError.message}`,
      collectorError.cause,
      collectorError.status,
    );
  }
}

/**
 * Collects pull request state from GitHub REST and GraphQL APIs.
 *
 * Each REST request (including every pagination page) and GraphQL page can retry
 * three times. All requests within one collection share a 30 second cumulative
 * sleep budget; server Retry-After/reset deadlines are never shortened to fit it.
 * Retry state is isolated across concurrent collections, even on shared clients.
 * Inject clients without additional retry/throttling plugins to preserve bounds.
 */
export class GitHubCollector {
  private readonly retryOptions: CollectorRetryOptions;
  private readonly defaultCollectPrAgentProvenance: boolean;

  constructor(
    private readonly rest: Octokit,
    private readonly graph: GraphqlClient,
    options: GitHubCollectorOptions = {},
  ) {
    this.retryOptions = options;
    this.defaultCollectPrAgentProvenance = options.collectPrAgentProvenance ?? false;
  }

  async collectPullRequest(input: CollectPullRequestInput): Promise<GitHubPullRequestData> {
    try {
      const retry = createRetryRequest(this.retryOptions);
      return await withRestRetries(this.rest, retry, () => this.collect(input, retry));
    } catch (error) {
      throw toCollectorError(error);
    }
  }

  private async collect(
    input: CollectPullRequestInput,
    retry: RetryRequest,
  ): Promise<GitHubPullRequestData> {
    const { owner, repo, pullRequestNumber } = input;
    const configPath = input.configPath ?? POLICY_FILE_PATH;
    if (
      configPath.length === 0 ||
      /[\\:]/.test(configPath) ||
      [...configPath].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      ) ||
      configPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new GitHubCollectorError(
        "policy",
        "configPath must be a normalized repository-relative file path.",
      );
    }
    const { data: pullRequest } = await this.rest.rest.pulls.get({
      owner,
      repo,
      pull_number: pullRequestNumber,
    });
    const evaluationSha = input.evaluationSha ?? pullRequest.head.sha;
    const policyVersion = input.policySha ?? pullRequest.base.sha;
    let ancestryPages = 0;
    let ancestryItems = 0;

    const [
      changedFilePaths,
      comments,
      reviews,
      checkRuns,
      statuses,
      reviewThreads,
      policyContent,
      commits,
    ] = await Promise.all([
      collectChangedFilePaths(this.graph, owner, repo, pullRequestNumber, retry),
      this.rest.paginate(
        this.rest.rest.issues.listComments,
        {
          owner,
          repo,
          issue_number: pullRequestNumber,
          per_page: PAGE_SIZE,
        },
        boundedRestPages("conversation_comments"),
      ),
      this.rest.paginate(
        this.rest.rest.pulls.listReviews,
        {
          owner,
          repo,
          pull_number: pullRequestNumber,
          per_page: PAGE_SIZE,
        },
        boundedRestPages("reviews"),
      ),
      this.rest.paginate(
        this.rest.rest.checks.listForRef,
        {
          owner,
          repo,
          ref: evaluationSha,
          per_page: PAGE_SIZE,
        },
        boundedRestPages("check_runs"),
      ),
      this.rest.paginate(
        this.rest.rest.repos.listCommitStatusesForRef,
        {
          owner,
          repo,
          ref: evaluationSha,
          per_page: PAGE_SIZE,
        },
        boundedRestPages("commit_statuses"),
      ),
      collectReviewThreads(this.graph, owner, repo, pullRequestNumber, retry),
      getPolicyContent(this.rest, owner, repo, policyVersion, configPath),
      // A bounded subset is sufficient to prove membership, never non-membership.
      // Missing historical commits keep findings unresolved in the normalizers.
      this.rest.paginate(
        this.rest.rest.repos.listCommits,
        { owner, repo, sha: pullRequest.head.sha, per_page: PAGE_SIZE },
        (response, done) => {
          ancestryPages += 1;
          const page = response.data.slice(0, MAX_CONNECTION_ITEMS - ancestryItems);
          ancestryItems += page.length;
          if (ancestryPages >= MAX_CONNECTION_PAGES || ancestryItems >= MAX_CONNECTION_ITEMS)
            done();
          return page;
        },
      ),
    ]);
    const latestStatuses = new Map<string, (typeof statuses)[number]>();
    for (const status of statuses) {
      const latest = latestStatuses.get(status.context);
      if (latest === undefined || Date.parse(status.created_at) > Date.parse(latest.created_at)) {
        latestStatuses.set(status.context, status);
      }
    }

    const headRepoFullName = pullRequest.head.repo?.full_name;
    const baseRepoFullName = pullRequest.base.repo?.full_name;

    const mappedCheckRuns: GitHubCheckRun[] = checkRuns.map((check) => ({
      id: check.id,
      name: check.name,
      status: check.status,
      conclusion: check.conclusion ?? null,
      commitSha: check.head_sha,
      detailsUrl: check.html_url ?? null,
      appSlug: check.app?.slug ?? null,
      output: {
        title: check.output.title ?? null,
        summary: check.output.summary ?? null,
        text: check.output.text ?? null,
      },
      startedAt: check.started_at ?? null,
      completedAt: check.completed_at ?? null,
    }));

    const prAgentCheckRunUrls = mappedCheckRuns
      .filter((check) => isTrustedPrAgentCheckRun(check))
      .map((check) => check.detailsUrl);

    const prAgentCommentDigests = new Map<number, string>();
    for (const comment of comments) {
      const login = comment.user?.login?.toLowerCase();
      const commentBody = comment.body ?? "";
      if (
        (login === "github-actions" || login === "github-actions[bot]") &&
        (commentBody.includes("<!-- pr-agent:review:full -->") ||
          commentBody.includes("<!-- pr-agent-review-state:v1"))
      ) {
        prAgentCommentDigests.set(comment.id, digestBody(commentBody));
      }
    }

    const hasPrAgentActivity = prAgentCheckRunUrls.length > 0 || prAgentCommentDigests.size > 0;

    const collectProvenance =
      input.collectPrAgentProvenance ?? this.defaultCollectPrAgentProvenance;
    const prAgentProvenance =
      collectProvenance && hasPrAgentActivity
        ? await collectPrAgentProvenance({
            rest: this.rest,
            retry: (_operation, request) => request(),
            owner,
            repo,
            pullRequestNumber,
            headSha: pullRequest.head.sha,
            checkRunUrls: prAgentCheckRunUrls,
            commentDigests: prAgentCommentDigests,
          })
        : undefined;

    return {
      repository: `${owner}/${repo}`,
      pullRequestNumber,
      headSha: pullRequest.head.sha,
      body: pullRequest.body ?? null,
      ancestorCommitShas: [...new Set(commits.map((commit) => commit.sha))].filter(
        (sha) => sha !== pullRequest.head.sha,
      ),
      baseSha: pullRequest.base.sha,
      headRef: pullRequest.head.ref,
      baseRef: pullRequest.base.ref,
      isFork: !headRepoFullName || !baseRepoFullName || headRepoFullName !== baseRepoFullName,
      isDraft: pullRequest.draft ?? false,
      mergeable: pullRequest.mergeable ?? null,
      authorLogin: pullRequest.user?.login ?? null,
      evaluationSha,
      policyVersion,
      changedFilePaths,
      reviewThreads,
      conversationComments: comments.map((comment) => ({
        id: comment.id,
        authorLogin: comment.user?.login ?? null,
        body: comment.body ?? null,
        bodyDigest: digestBody(comment.body ?? null),
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      })),
      reviews: reviews.map((review) => ({
        id: review.id,
        reviewerLogin: review.user?.login ?? null,
        state: review.state,
        commitSha: review.commit_id,
        submittedAt: review.submitted_at ?? null,
        body: review.body ?? null,
        bodyDigest: digestBody(review.body ?? null),
      })),
      checkRuns: mappedCheckRuns,
      commitStatuses: [...latestStatuses.values()].map((status) => ({
        context: status.context,
        state: status.state,
        commitSha: evaluationSha,
        targetUrl: status.target_url,
        description: status.description,
        createdAt: status.created_at,
        updatedAt: status.updated_at,
      })),
      ...(prAgentProvenance ? { prAgentProvenance } : {}),
      policyContent,
    };
  }
}

/**
 * Creates a collector authenticated with a GitHub token.
 *
 * Pass `{ debug: (event) => logger.debug(event) }` as the second argument to
 * observe retries. Events contain only operation, status, attempt and delay
 * metadata, never request headers, bodies, URLs or error messages. Logging
 * failures are ignored. sleep/random/now options support deterministic tests.
 * The factory uses plain Octokit without nested retry or throttling plugins.
 *
 * @throws {TypeError} If the token is empty or contains only whitespace.
 */
export function createGitHubCollector(
  token: string,
  options: GitHubCollectorOptions = {},
): GitHubCollector {
  const authToken = token.trim();
  if (authToken.length === 0) {
    throw new TypeError("A non-empty GitHub token is required to create a GitHubCollector.");
  }

  const rest = new Octokit({ auth: authToken });
  const graph = graphql.defaults({
    headers: { authorization: `token ${authToken}` },
  });
  return new GitHubCollector(rest, graph, {
    collectPrAgentProvenance: true,
    ...options,
  });
}
