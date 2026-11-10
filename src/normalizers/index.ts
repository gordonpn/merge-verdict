import type { GitHubPullRequestData } from "../collector/github-collector.js";
import type { ReviewerExecutionRecord } from "../models/reviewer.js";
import {
  computeStateFingerprint,
  type ReviewSnapshot,
  ReviewSnapshotSchema,
} from "../models/snapshot.js";
import { codeRabbitNormalizer } from "./coderabbit.js";
import { codexNormalizer } from "./codex.js";
import { copilotNormalizer } from "./copilot.js";
import { deepSeekNormalizer } from "./deepseek.js";
import { normalizeCheckRuns } from "./generic-checks.js";
import { sourceryNormalizer } from "./sourcery.js";
import type { NormalizerInput, ReviewerNormalizer } from "./types.js";

export { codeRabbitNormalizer, normalizeCodeRabbitReviewer } from "./coderabbit.js";
export { codexNormalizer, normalizeCodexReviewer } from "./codex.js";
export { copilotNormalizer, normalizeCopilotReviewer } from "./copilot.js";
export { deepSeekNormalizer, normalizeDeepSeekReviewer } from "./deepseek.js";
export { normalizeCheckRuns } from "./generic-checks.js";
export { normalizeSourceryReviewer, sourceryNormalizer } from "./sourcery.js";
export type { NormalizerInput, ReviewerNormalizer } from "./types.js";

/**
 * Standard suite of automated reviewer normalizers supported out of the box.
 */
export const DEFAULT_REVIEWER_NORMALIZERS: readonly ReviewerNormalizer[] = [
  codeRabbitNormalizer,
  sourceryNormalizer,
  codexNormalizer,
  deepSeekNormalizer,
  copilotNormalizer,
];

/**
 * Configuration options for generating a review snapshot.
 */
export interface NormalizeSnapshotOptions {
  readonly normalizers?: readonly ReviewerNormalizer[];
  readonly capturedAt?: string;
}

/**
 * Transforms raw pull request collection data into an immutable, validated ReviewSnapshot.
 *
 * @param prData Raw GitHub pull request data collected from APIs.
 * @param options Customization options such as custom reviewer normalizers.
 * @returns Fully validated ReviewSnapshot.
 */
export function buildReviewSnapshotFromPullRequest(
  prData: GitHubPullRequestData,
  options: NormalizeSnapshotOptions = {},
): ReviewSnapshot {
  const sortedReviews = [...prData.reviews].sort((a, b) => {
    const timeA = a.submittedAt ? Date.parse(a.submittedAt) : 0;
    const timeB = b.submittedAt ? Date.parse(b.submittedAt) : 0;
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    if (a.state === "CHANGES_REQUESTED" && b.state !== "CHANGES_REQUESTED") {
      return 1;
    }
    if (b.state === "CHANGES_REQUESTED" && a.state !== "CHANGES_REQUESTED") {
      return -1;
    }
    return a.id - b.id;
  });

  const input: NormalizerInput = {
    headSha: prData.headSha,
    repository: prData.repository,
    ancestorCommitShas: [prData.baseSha, prData.headSha],
    reviewThreads: prData.reviewThreads,
    reviews: sortedReviews,
    checkRuns: prData.checkRuns,
    conversationComments: prData.conversationComments,
    commitStatuses: prData.commitStatuses,
  };

  const normalizers = options.normalizers ?? DEFAULT_REVIEWER_NORMALIZERS;
  const reviewers: Record<string, ReviewerExecutionRecord> = {};
  for (const normalizer of normalizers) {
    reviewers[normalizer.reviewerId] = normalizer.normalize(input);
  }

  const checkRuns = normalizeCheckRuns(prData.checkRuns, prData.commitStatuses);
  const unresolvedThreadCount = prData.reviewThreads.filter((t) => !t.isResolved).length;

  const latestReviewStateByUser = new Map<string, string>();
  for (const review of sortedReviews) {
    if (
      !review.reviewerLogin ||
      review.state === "DISMISSED" ||
      review.state === "COMMENTED" ||
      review.state === "PENDING"
    ) {
      continue;
    }
    latestReviewStateByUser.set(review.reviewerLogin.toLowerCase(), review.state);
  }

  let blockingDecisionCount = 0;
  for (const state of latestReviewStateByUser.values()) {
    if (state === "CHANGES_REQUESTED") {
      blockingDecisionCount++;
    }
  }

  const stateFingerprint = computeStateFingerprint({
    headSha: prData.headSha,
    unresolvedThreadCount,
    blockingDecisionCount,
    reviewers,
    checkRuns,
  });

  const capturedAt = options.capturedAt ?? new Date().toISOString();

  return ReviewSnapshotSchema.parse({
    repository: prData.repository,
    pullRequestNumber: prData.pullRequestNumber,
    headSha: prData.headSha,
    baseSha: prData.baseSha,
    isDraft: prData.isDraft,
    stateFingerprint,
    reviewers,
    unresolvedThreadCount,
    blockingDecisionCount,
    checkRuns,
    capturedAt,
  });
}
