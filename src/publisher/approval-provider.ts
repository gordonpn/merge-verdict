import { publishAppApproval } from "./providers/github-app.js";
import { publishCopilotApproval } from "./providers/github-copilot.js";
import { publishNoApproval } from "./providers/none.js";

export type ApprovalProviderName = "github_copilot" | "github_app" | "none";
export interface PullRequestTarget {
  owner: string;
  repo: string;
  pullNumber: number;
}
export interface ApprovalInput extends PullRequestTarget {
  headSha: string;
  verdict: "PASS" | "PENDING" | "FAIL" | "STALE" | "ERROR";
  /** Must come from protected-base path risk policy, never from PR input. */
  pathEligible: boolean;
  checkRunUrl: string;
  resolvedEffort?: "Lite" | "Balanced" | "Max";
}
export interface ApprovalReview {
  id: number;
  author: string;
  commitId: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string;
}
export interface RecognitionTarget extends PullRequestTarget {
  headSha: string;
  reviewId: number;
}
/** Trusted adapters must supply complete reviews and authenticated ownership evidence. */
export interface ApprovalClient {
  getHeadSha(target: PullRequestTarget): Promise<string>;
  listReviews(target: PullRequestTarget): Promise<readonly ApprovalReview[]>;
  submitApproval(
    target: PullRequestTarget & { commitId: string; body: string },
  ): Promise<ApprovalReview>;
  dismissReview(target: PullRequestTarget & { reviewId: number }): Promise<void>;
  /** Attests this is an approval managed by this installation, not merely a matching login. */
  isOwnedReview(review: ApprovalReview): boolean;
  /** Optional deployment-specific, documented capability, not an assumed GitHub API. */
  requestCopilotReview?(
    target: PullRequestTarget & { headSha: string; effort?: "Lite" | "Balanced" | "Max" },
  ): Promise<void>;
  /** Must verify the specific active review and head against actual repository review rules. */
  verifyBranchProtectionRecognition?(target: RecognitionTarget): Promise<boolean | "unknown">;
}
export interface ApprovalResult {
  approvalStatus:
    | "submitted"
    | "verified_existing"
    | "requested_pending"
    | "skipped_by_policy"
    | "skipped_provider_none"
    | "failed";
  provider: ApprovalProviderName;
  headSha: string;
  countsTowardBranchProtection: "unknown" | "verified" | "not_applicable";
  reviewId?: number;
}
export interface ApprovalProvider {
  publish(input: ApprovalInput): Promise<ApprovalResult>;
}
export function result(
  approvalStatus: ApprovalResult["approvalStatus"],
  provider: ApprovalProviderName,
  headSha: string,
): ApprovalResult {
  return { approvalStatus, provider, headSha, countsTowardBranchProtection: "unknown" };
}
export function target(input: ApprovalInput): PullRequestTarget {
  return { owner: input.owner, repo: input.repo, pullNumber: input.pullNumber };
}
/** Conservatively accept only the latest submitted decision from this reviewer. */
export function activeApproval(
  reviews: readonly ApprovalReview[],
  author: string,
  sha: string,
): ApprovalReview | undefined {
  const submitted = reviews.filter(
    (review) => review.author === author && review.state !== "PENDING",
  );
  if (submitted.some((review) => !Number.isFinite(Date.parse(review.submittedAt))))
    return undefined;
  const ordered = [...submitted].sort(
    (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt) || b.id - a.id,
  );
  const latest = ordered[0];
  return latest?.state === "APPROVED" && latest.commitId === sha ? latest : undefined;
}
export async function recognizedResult(
  client: ApprovalClient,
  input: ApprovalInput,
  review: ApprovalReview,
  provider: ApprovalProviderName,
  approvalStatus: "submitted" | "verified_existing" = "verified_existing",
): Promise<ApprovalResult> {
  const recognition =
    (await client.verifyBranchProtectionRecognition?.({
      ...target(input),
      headSha: input.headSha,
      reviewId: review.id,
    })) ?? "unknown";
  if ((await client.getHeadSha(target(input))) !== input.headSha)
    return result("failed", provider, input.headSha);
  return {
    approvalStatus,
    provider,
    headSha: input.headSha,
    countsTowardBranchProtection:
      recognition === true ? "verified" : recognition === false ? "not_applicable" : "unknown",
    reviewId: review.id,
  };
}
export function createApprovalProvider(
  name: ApprovalProviderName,
  client: ApprovalClient,
): ApprovalProvider {
  return {
    async publish(input) {
      if (input.verdict !== "PASS" || input.pathEligible !== true) {
        // Invalidation is limited to authenticated installation-owned approvals.
        const reviews = await client.listReviews(target(input));
        for (const review of reviews) {
          if (review.state === "APPROVED" && client.isOwnedReview(review)) {
            await client.dismissReview({ ...target(input), reviewId: review.id });
          }
        }
        return result("skipped_by_policy", name, input.headSha);
      }
      if (name === "none") return publishNoApproval(input);
      if ((await client.getHeadSha(target(input))) !== input.headSha)
        return result("failed", name, input.headSha);
      try {
        switch (name) {
          case "github_app":
            return await publishAppApproval(client, input);
          case "github_copilot":
            return await publishCopilotApproval(client, input);
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 422
        )
          return result("failed", name, input.headSha);
        throw error;
      }
    },
  };
}
