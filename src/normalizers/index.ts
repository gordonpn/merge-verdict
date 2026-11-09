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
  const input: NormalizerInput = {
    headSha: prData.headSha,
    reviewThreads: prData.reviewThreads,
    reviews: prData.reviews,
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

  let blockingDecisionCount = 0;
  for (const reviewer of Object.values(reviewers)) {
    if (reviewer.verdict === "CHANGES_REQUESTED") {
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
