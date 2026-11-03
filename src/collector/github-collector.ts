import { createHash } from "node:crypto";
import { GraphqlResponseError, graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

type GraphqlClient = typeof graphql;

const PAGE_SIZE = 100;
const REVIEW_THREAD_COMMENT_FIELDS = `
  id
  body
  author { login }
  path
  line
  originalLine
  createdAt
  updatedAt
  commit { oid }
`;

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
          nodes {
            id
            isResolved
            isOutdated
            resolvedBy { login }
            path
            line
            originalLine
            comments(first: ${PAGE_SIZE}) {
              nodes { ${REVIEW_THREAD_COMMENT_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const CHANGED_FILES_QUERY = `
  query ChangedFiles($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        files(first: ${PAGE_SIZE}, after: $cursor) {
          nodes { path }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const POLICY_FILE_PATH = ".github/merge-verdict.yml";
const REVIEW_THREAD_COMMENT_CONCURRENCY = 5;

const THREAD_COMMENTS_QUERY = `
  query ReviewThreadComments($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: ${PAGE_SIZE}, after: $cursor) {
          nodes { ${REVIEW_THREAD_COMMENT_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

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
}

export interface GitHubReviewThreadComment {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly bodyDigest: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly originalLine: number | null;
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

export interface GitHubReviewSubmission {
  readonly id: number;
  readonly reviewerLogin: string | null;
  readonly state: string;
  readonly commitSha: string | null;
  readonly submittedAt: string | null;
  readonly body: string | null;
  readonly bodyDigest: string | null;
}

export interface GitHubCheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly commitSha: string;
  readonly detailsUrl: string | null;
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
  readonly state: string;
  readonly commitSha: string;
  readonly targetUrl: string | null;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GitHubPullRequestData {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly headRef: string;
  readonly baseRef: string;
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
  return typeof record?.status === "number" ? record.status : null;
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

  return new GitHubCollectorError(kind, message, error, status);
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

async function collectThreadComments(
  client: GraphqlClient,
  thread: ReviewThreadNode,
): Promise<GitHubReviewThreadComment[]> {
  const comments = thread.comments.nodes.map(mapThreadComment);
  let pageInfo = thread.comments.pageInfo;
  let cursor: string | null = null;

  while (pageInfo.hasNextPage) {
    const nextCursor = requireNextCursor(pageInfo, cursor);
    const page = await client<ReviewThreadCommentsResponse>(THREAD_COMMENTS_QUERY, {
      threadId: thread.id,
      cursor: nextCursor,
    });
    if (page.node === null || page.node.comments === undefined) {
      throw new GitHubCollectorError("api", "GitHub returned no review thread for a comment page.");
    }
    cursor = nextCursor;
    comments.push(...page.node.comments.nodes.map(mapThreadComment));
    pageInfo = page.node.comments.pageInfo;
  }

  return comments;
}

async function collectReviewThreads(
  client: GraphqlClient,
  owner: string,
  repo: string,
  pullRequestNumber: number,
): Promise<GitHubReviewThread[]> {
  const threads: GitHubReviewThread[] = [];
  let cursor: string | null = null;

  while (true) {
    const data = await client<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
      owner,
      repo,
      number: pullRequestNumber,
      cursor,
    });
    const pullRequest = data.repository?.pullRequest;
    if (pullRequest === null || pullRequest === undefined) {
      throw new GitHubCollectorError("api", "GitHub returned no pull request review data.");
    }

    const connection = pullRequest.reviewThreads;
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
          comments: await collectThreadComments(client, thread),
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
): Promise<string[]> {
  const paths: string[] = [];
  let cursor: string | null = null;

  while (true) {
    const data = await client<ChangedFilesResponse>(CHANGED_FILES_QUERY, {
      owner,
      repo,
      number: pullRequestNumber,
      cursor,
    });
    const pullRequest = data.repository?.pullRequest;
    if (pullRequest === null || pullRequest === undefined) {
      throw new GitHubCollectorError("api", "GitHub returned no pull request file data.");
    }

    const connection = pullRequest.files;
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
): Promise<string> {
  try {
    const { data } = await rest.rest.repos.getContent({
      owner,
      repo,
      path: POLICY_FILE_PATH,
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
    const kind =
      error instanceof GitHubCollectorError || collectorError.status === 404
        ? "policy"
        : collectorError.kind;
    throw new GitHubCollectorError(
      kind,
      `Failed to read ${POLICY_FILE_PATH} at ${policySha}: ${collectorError.message}`,
      error,
      collectorError.status,
    );
  }
}

/**
 * Collects pull request state from GitHub REST and GraphQL APIs.
 */
export class GitHubCollector {
  constructor(
    private readonly rest: Octokit,
    private readonly graph: GraphqlClient,
  ) {}

  async collectPullRequest(input: CollectPullRequestInput): Promise<GitHubPullRequestData> {
    try {
      return await this.collect(input);
    } catch (error) {
      throw toCollectorError(error);
    }
  }

  private async collect(input: CollectPullRequestInput): Promise<GitHubPullRequestData> {
    const { owner, repo, pullRequestNumber } = input;
    const { data: pullRequest } = await this.rest.rest.pulls.get({
      owner,
      repo,
      pull_number: pullRequestNumber,
    });
    const evaluationSha = input.evaluationSha ?? pullRequest.head.sha;
    const policyVersion = input.policySha ?? pullRequest.base.sha;

    const [changedFilePaths, comments, reviews, checkRuns, statuses, reviewThreads, policyContent] =
      await Promise.all([
        collectChangedFilePaths(this.graph, owner, repo, pullRequestNumber),
        this.rest.paginate(this.rest.rest.issues.listComments, {
          owner,
          repo,
          issue_number: pullRequestNumber,
          per_page: PAGE_SIZE,
        }),
        this.rest.paginate(this.rest.rest.pulls.listReviews, {
          owner,
          repo,
          pull_number: pullRequestNumber,
          per_page: PAGE_SIZE,
        }),
        this.rest.paginate(this.rest.rest.checks.listForRef, {
          owner,
          repo,
          ref: evaluationSha,
          per_page: PAGE_SIZE,
        }),
        this.rest.paginate(this.rest.rest.repos.listCommitStatusesForRef, {
          owner,
          repo,
          ref: evaluationSha,
          per_page: PAGE_SIZE,
        }),
        collectReviewThreads(this.graph, owner, repo, pullRequestNumber),
        getPolicyContent(this.rest, owner, repo, policyVersion),
      ]);
    const latestStatuses = new Map<string, (typeof statuses)[number]>();
    for (const status of statuses) {
      const latest = latestStatuses.get(status.context);
      if (latest === undefined || Date.parse(status.created_at) > Date.parse(latest.created_at)) {
        latestStatuses.set(status.context, status);
      }
    }

    return {
      repository: `${owner}/${repo}`,
      pullRequestNumber,
      headSha: pullRequest.head.sha,
      baseSha: pullRequest.base.sha,
      headRef: pullRequest.head.ref,
      baseRef: pullRequest.base.ref,
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
      checkRuns: checkRuns.map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion ?? null,
        commitSha: check.head_sha,
        detailsUrl: check.html_url ?? null,
        output: {
          title: check.output.title ?? null,
          summary: check.output.summary ?? null,
          text: check.output.text ?? null,
        },
        startedAt: check.started_at ?? null,
        completedAt: check.completed_at ?? null,
      })),
      commitStatuses: [...latestStatuses.values()].map((status) => ({
        context: status.context,
        state: status.state,
        commitSha: evaluationSha,
        targetUrl: status.target_url,
        description: status.description,
        createdAt: status.created_at,
        updatedAt: status.updated_at,
      })),
      policyContent,
    };
  }
}

/**
 * Creates a collector authenticated with a GitHub token.
 *
 * @throws {TypeError} If the token is empty or contains only whitespace.
 */
export function createGitHubCollector(token: string): GitHubCollector {
  const authToken = token.trim();
  if (authToken.length === 0) {
    throw new TypeError("A non-empty GitHub token is required to create a GitHubCollector.");
  }

  const rest = new Octokit({ auth: authToken });
  const graph = graphql.defaults({
    headers: { authorization: `token ${authToken}` },
  });
  return new GitHubCollector(rest, graph);
}
