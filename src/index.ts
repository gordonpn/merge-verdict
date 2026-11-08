/**
 * Merge Verdict core package entry point.
 */
export const VERSION = "0.1.0";

export type {
  CollectPullRequestInput,
  GitHubCheckRun,
  GitHubCheckRunConclusion,
  GitHubCheckRunStatus,
  GitHubCollectorErrorKind,
  GitHubCommitStatus,
  GitHubCommitStatusState,
  GitHubConversationComment,
  GitHubPullRequestData,
  GitHubReviewState,
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
