import { type ApprovalInput, type ApprovalResult, result } from "../approval-provider.js";

export function publishNoApproval(input: ApprovalInput): ApprovalResult {
  return result("skipped_provider_none", "none", input.headSha);
}
