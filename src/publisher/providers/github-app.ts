import {
  type ApprovalClient,
  type ApprovalInput,
  type ApprovalResult,
  activeApproval,
  recognizedResult,
  result,
  target,
} from "../approval-provider.js";

export async function publishAppApproval(
  client: ApprovalClient,
  input: ApprovalInput,
): Promise<ApprovalResult> {
  if (input.verdict !== "PASS" || input.pathEligible !== true)
    return result("skipped_by_policy", "github_app", input.headSha);
  const reviews = await client.listReviews(target(input));
  const existing = activeApproval(reviews, "merge-verdict[bot]", input.headSha);
  if ((await client.getHeadSha(target(input))) !== input.headSha)
    return result("failed", "github_app", input.headSha);
  if (existing && client.isOwnedReview(existing))
    return recognizedResult(client, input, existing, "github_app");
  const review = await client.submitApproval({
    ...target(input),
    commitId: input.headSha,
    body: `Merge Verdict approved commit ${input.headSha} after review reconciliation and verification-policy satisfaction. Verification report: ${input.checkRunUrl}`,
  });
  if (
    review.state !== "APPROVED" ||
    review.commitId !== input.headSha ||
    review.author !== "merge-verdict[bot]" ||
    !client.isOwnedReview(review)
  )
    return result("failed", "github_app", input.headSha);
  return recognizedResult(client, input, review, "github_app", "submitted");
}
