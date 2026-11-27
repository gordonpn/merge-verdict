import type { Octokit } from "@octokit/rest";
import {
  type ApprovalClient,
  type ApprovalInput,
  type ApprovalProviderName,
  type ApprovalResult,
  type ApprovalReview,
  createApprovalProvider,
} from "./approval-provider.js";

export const DEFAULT_APPROVAL_AUTHOR = "merge-verdict[bot]";
export const DEFAULT_DISMISS_MESSAGE =
  "Dismissed Merge Verdict approval because verification criteria are no longer satisfied.";
export const DEFAULT_MAX_REVIEW_PAGES = 10;

const REVIEWS_PAGE_SIZE = 100;
// Match complete relation tokens without depending on Link parameter order.
const NEXT_RELATION_PATTERN =
  /;\s*rel\s*=\s*(?:"(?:[^"]*\s)?next(?:\s[^"]*)?"|next)(?=\s*(?:;|,|$))/i;

export interface OctokitApprovalClientOptions {
  readonly expectedAuthor?: string;
  readonly isOwnedReview?: (review: ApprovalReview) => boolean;
  readonly dismissMessage?: string;
  readonly maxReviewPages?: number;
  readonly requestCopilotReview?: ApprovalClient["requestCopilotReview"];
  readonly verifyBranchProtectionRecognition?: ApprovalClient["verifyBranchProtectionRecognition"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSha(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/\s/.test(value);
}

function isApprovalReviewState(value: unknown): value is ApprovalReview["state"] {
  return (
    value === "APPROVED" ||
    value === "CHANGES_REQUESTED" ||
    value === "COMMENTED" ||
    value === "DISMISSED" ||
    value === "PENDING"
  );
}

function resolveSubmittedAt(state: ApprovalReview["state"], rawSubmittedAt: unknown): string {
  if (state === "PENDING" && (rawSubmittedAt === undefined || rawSubmittedAt === null)) {
    return "";
  }
  if (typeof rawSubmittedAt === "string" && Number.isFinite(Date.parse(rawSubmittedAt))) {
    return rawSubmittedAt;
  }
  throw new Error("GitHub pull request review is missing a valid submitted_at timestamp.");
}

function mapApprovalReview(raw: unknown): ApprovalReview {
  if (!isRecord(raw)) {
    throw new Error("GitHub pull request review payload must be an object.");
  }
  if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
    throw new Error("GitHub pull request review is missing a valid positive integer id.");
  }
  if (!isRecord(raw.user) || typeof raw.user.login !== "string" || raw.user.login.trim() === "") {
    throw new Error("GitHub pull request review is missing a valid author login.");
  }
  if (!isApprovalReviewState(raw.state)) {
    throw new Error("GitHub pull request review has an unsupported state.");
  }
  if (!isValidSha(raw.commit_id)) {
    throw new Error("GitHub pull request review is missing a valid commit_id.");
  }

  return {
    id: raw.id,
    author: raw.user.login,
    commitId: raw.commit_id,
    state: raw.state,
    submittedAt: resolveSubmittedAt(raw.state, raw.submitted_at),
  };
}

function parseNextPageLink(response: unknown): {
  readonly hasExplicitLink: boolean;
  readonly hasNextLink: boolean;
} {
  const headers = isRecord(response) && isRecord(response.headers) ? response.headers : null;
  const linkHeader = headers?.link;
  if (typeof linkHeader !== "string") {
    return { hasExplicitLink: false, hasNextLink: false };
  }
  return {
    hasExplicitLink: true,
    hasNextLink: NEXT_RELATION_PATTERN.test(linkHeader),
  };
}

/**
 * Creates a bounded Octokit approval client with caller-attested review ownership.
 * Ownership is false when no isOwnedReview callback is supplied.
 * Throws for invalid options, malformed responses, and truncated review lists.
 */
export function createOctokitApprovalClient(
  octokit: Octokit,
  options: OctokitApprovalClientOptions = {},
): ApprovalClient {
  const api = octokit.rest ?? octokit;
  const expectedAuthor = options.expectedAuthor ?? DEFAULT_APPROVAL_AUTHOR;
  const dismissMessage = options.dismissMessage ?? DEFAULT_DISMISS_MESSAGE;
  const maxReviewPages = options.maxReviewPages ?? DEFAULT_MAX_REVIEW_PAGES;

  if (!Number.isInteger(maxReviewPages) || maxReviewPages <= 0) {
    throw new Error("maxReviewPages must be a positive integer.");
  }
  if (dismissMessage.trim().length === 0) {
    throw new Error("dismissMessage must be a non-empty string.");
  }

  return {
    async getHeadSha(target) {
      const { data } = await api.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pullNumber,
      });
      const sha = isRecord(data) && isRecord(data.head) ? data.head.sha : undefined;
      if (!isValidSha(sha)) {
        throw new Error("GitHub pull request response is missing a valid head.sha.");
      }
      return sha;
    },

    async listReviews(target) {
      const reviews: ApprovalReview[] = [];
      for (let page = 1; page <= maxReviewPages; page += 1) {
        const response = await api.pulls.listReviews({
          owner: target.owner,
          repo: target.repo,
          pull_number: target.pullNumber,
          per_page: REVIEWS_PAGE_SIZE,
          page,
        });
        const data: unknown = response.data;
        if (!Array.isArray(data)) {
          throw new Error("GitHub pull request reviews response is not an array.");
        }
        for (const item of data) {
          reviews.push(mapApprovalReview(item));
        }

        const { hasExplicitLink, hasNextLink } = parseNextPageLink(response);
        if (hasExplicitLink) {
          if (!hasNextLink) break;
          if (page === maxReviewPages) {
            throw new Error(
              `GitHub pull request reviews exceeded maxReviewPages (${maxReviewPages}).`,
            );
          }
          continue;
        }

        if (data.length < REVIEWS_PAGE_SIZE) {
          break;
        }
        if (page === maxReviewPages) {
          const overflow = await api.pulls.listReviews({
            owner: target.owner,
            repo: target.repo,
            pull_number: target.pullNumber,
            per_page: REVIEWS_PAGE_SIZE,
            page: page + 1,
          });
          if (
            !Array.isArray(overflow.data) ||
            overflow.data.length > 0 ||
            parseNextPageLink(overflow).hasNextLink
          ) {
            throw new Error(
              `GitHub pull request reviews exceeded maxReviewPages (${maxReviewPages}).`,
            );
          }
          break;
        }
      }
      return reviews;
    },

    async submitApproval(target) {
      if (!isValidSha(target.commitId)) {
        throw new Error("submitApproval requires a valid non-empty commitId.");
      }
      const { data } = await api.pulls.createReview({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pullNumber,
        commit_id: target.commitId,
        event: "APPROVE",
        body: target.body,
      });
      return mapApprovalReview(data);
    },

    async dismissReview(target) {
      if (!Number.isInteger(target.reviewId) || target.reviewId <= 0) {
        throw new Error("dismissReview requires a valid positive integer reviewId.");
      }
      await api.pulls.dismissReview({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pullNumber,
        review_id: target.reviewId,
        message: dismissMessage,
      });
    },

    isOwnedReview(review) {
      if (expectedAuthor.trim().length === 0 || review.author !== expectedAuthor) {
        return false;
      }
      if (!options.isOwnedReview) {
        return false;
      }
      return options.isOwnedReview(review) === true;
    },

    ...(options.requestCopilotReview !== undefined
      ? { requestCopilotReview: options.requestCopilotReview }
      : {}),
    ...(options.verifyBranchProtectionRecognition !== undefined
      ? { verifyBranchProtectionRecognition: options.verifyBranchProtectionRecognition }
      : {}),
  };
}

/**
 * Publishes or dismisses pull request approval state for the configured provider
 * using the supplied ApprovalClient.
 */
export async function publishPullRequestApproval(
  providerName: ApprovalProviderName,
  client: ApprovalClient,
  input: ApprovalInput,
): Promise<ApprovalResult> {
  return createApprovalProvider(providerName, client).publish(input);
}
