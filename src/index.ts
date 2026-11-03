/**
 * Merge Verdict core package entry point.
 */
export const VERSION = "0.1.0";

export type {
  CollectPullRequestInput,
  GitHubCheckRun,
  GitHubCollectorErrorKind,
  GitHubCommitStatus,
  GitHubConversationComment,
  GitHubPullRequestData,
  GitHubReviewSubmission,
  GitHubReviewThread,
  GitHubReviewThreadComment,
} from "./collector/github-collector.js";
export {
  createGitHubCollector,
  GitHubCollector,
  GitHubCollectorError,
} from "./collector/github-collector.js";
export * from "./models/index.js";
