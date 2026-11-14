# Standalone approval provider strategies

These strategies implement the provider boundary described by [ADR 0002](https://github.com/gordonpn/merge-verdict/blob/758195ef94e4b7bb74a02339223c708c323e4ad0/docs/adr/0002-authoritative-status-check-vs-pr-approval.md). They do not publish checks or integrate the publisher with the policy evaluator. The required `merge-verdict` check remains authoritative. This is a partial implementation of issue #36; risk resolution and publisher integration remain followup work.

Use `createApprovalProvider(provider, client).publish(input)` from `src/publisher/approval-provider.ts`. The factory supports `github_copilot`, `github_app`, and `none`. Supply repository identity, PR number, evaluated head SHA, verdict, explicit `pathEligible`, and the authoritative check report URL. Resolve eligibility and optional `resolvedEffort` (`Lite`, `Balanced`, `Max`) from protected-base policy before calling this module. An absent or false eligibility never authorizes an approval. The trusted caller remains responsible for full review-snapshot revalidation and authentic check report references.

## Result contract

Every result records `provider`, evaluated `headSha`, `approvalStatus`, and `countsTowardBranchProtection`. A review identifier is included for recognized approvals.

| approvalStatus          | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `submitted`             | App returned an owned approval for the evaluated SHA                                         |
| `verified_existing`     | Latest submitted reviewer decision is an active approval for that SHA                        |
| `requested_pending`     | Optional Copilot request completed; no approval is asserted                                  |
| `skipped_by_policy`     | Verdict was not PASS or path eligibility was not explicitly true                             |
| `skipped_provider_none` | No review operation performed                                                                |
| `failed`                | Head moved, review unavailable, response not an approval, or HTTP 422 rejected the operation |

Recognition is `unknown` unless the optional trusted verifier provides actual evidence for this exact review and head. A positive result maps to `verified`; a negative result maps to `not_applicable`. Submission, Copilot identity, request completion, and passing verification do not establish that an approval satisfies a required review threshold. Recognition failure never asserts check success. Unexpected API errors propagate to the caller.

## Trusted client adapter contract

The adapter supplies authenticated GitHub operations; no Octokit instance, credentials, new dependency, or network transport is created by this module.

- `getHeadSha` reads the current PR head from GitHub. Strategies check it before writes and again before returning approval recognition. App reviews pass `commitId` explicitly. These checks reduce race windows but cannot make GitHub operations atomic.
- `listReviews` returns complete paginated, current review data with canonical authenticated author logins and submission timestamps. Missing pages, incomplete states, or untrusted PR text must not be supplied as review evidence. The latest submitted decision for a reviewer must be APPROVED on the evaluated SHA. Dismissed, stale, superseded, and malformed-date reviews are rejected conservatively. Pending drafts do not supersede submitted decisions.
- `submitApproval` must use the dedicated Merge Verdict App identity and submit `event: APPROVE` with the supplied `commitId` and body. It returns the actual GitHub review response. HTTP 422 is reported as `failed`; this module neither fails nor marks successful an authoritative check.
- `isOwnedReview` attests installation-specific ownership using trusted persisted review identifiers or equivalent authenticated provenance. A matching bot login alone is insufficient in production. Never claim ownership of unrelated Copilot or human reviews.
- `dismissReview` dismisses only the supplied owned approval. For non-PASS or ineligible inputs, the factory lists and dismisses prior owned approvals, without submitting or requesting a review. Failed dismissal propagates; callers must keep the authoritative gate blocking. The `none` provider also performs this cleanup on non-PASS or ineligible inputs. For eligible PASS inputs, `none` performs no network calls. It never submits or requests an approval.
- `requestCopilotReview` is optional and deployment-specific. Supply it only if a documented, supported, authenticated capability exists for the deployment. It must arrange review of the supplied current head, validate any head precondition, and honor the optional resolved effort or reject it explicitly. This repository assumes no GitHub REST endpoint or effort parameter exists. Without this capability, an absent Copilot approval returns `failed`; existing Copilot approvals can still be verified.
- `verifyBranchProtectionRecognition` is optional. It must establish whether the supplied active review ID on the supplied current head actually qualifies under repository review rules and settings, including reviewer eligibility and Code Owner constraints. Return `unknown` when evidence is incomplete. A configured review count or a bot approval response alone is insufficient.

## Lifecycle limits

Strategies are stateless. They do not serialize concurrent invocations, persist ownership, request retries, invalidate checks, resolve risk tiers, or revalidate the full review digest. A new blocking finding on an unchanged SHA still requires the bridge and publisher invalidation lifecycle. A head change after submission can leave an old-SHA review behind; the result is `failed` and the integration must perform owned-review cleanup. Use the factory for lifecycle dismissal; the strategy functions also suppress emission unless PASS and explicit eligibility are supplied.
