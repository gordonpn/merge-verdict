import {
  type ApprovalClient,
  type ApprovalInput,
  type ApprovalResult,
  activeApproval,
  recognizedResult,
  result,
  target,
} from "../approval-provider.js";

export async function publishCopilotApproval(
  client: ApprovalClient,
  input: ApprovalInput,
): Promise<ApprovalResult> {
  if (input.verdict !== "PASS" || input.pathEligible !== true)
    return result("skipped_by_policy", "github_copilot", input.headSha);
  const reviews = await client.listReviews(target(input));
  const existing = activeApproval(reviews, "copilot-pull-request-reviewer[bot]", input.headSha);
  if ((await client.getHeadSha(target(input))) !== input.headSha)
    return result("failed", "github_copilot", input.headSha);
  if (existing) return recognizedResult(client, input, existing, "github_copilot");
  if (!client.requestCopilotReview) return result("failed", "github_copilot", input.headSha);
  await client.requestCopilotReview({
    ...target(input),
    headSha: input.headSha,
    ...(input.resolvedEffort ? { effort: input.resolvedEffort } : {}),
  });
  if ((await client.getHeadSha(target(input))) !== input.headSha)
    return result("failed", "github_copilot", input.headSha);
  return result("requested_pending", "github_copilot", input.headSha);
}
