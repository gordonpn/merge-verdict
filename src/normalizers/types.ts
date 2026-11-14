import type {
  GitHubCheckRun,
  GitHubCommitStatus,
  GitHubConversationComment,
  GitHubReviewSubmission,
  GitHubReviewThread,
} from "../collector/github-collector.js";
import type { ReviewerExecutionRecord } from "../models/reviewer.js";

/**
 * Input data slice passed to reviewer normalizers.
 */
export interface NormalizerInput {
  readonly headSha: string;
  readonly repository?: string;
  readonly ancestorCommitShas?: readonly string[];
  readonly reviewThreads?: readonly GitHubReviewThread[];
  readonly reviews?: readonly GitHubReviewSubmission[];
  readonly checkRuns?: readonly GitHubCheckRun[];
  readonly conversationComments?: readonly GitHubConversationComment[];
  readonly commitStatuses?: readonly GitHubCommitStatus[];
}

/**
 * Adapter contract for normalizing third-party review data into uniform reviewer records.
 */
export interface ReviewerNormalizer {
  readonly reviewerId: string;
  readonly reviewerName: string;
  normalize(input: NormalizerInput): ReviewerExecutionRecord;
}
