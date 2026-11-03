# ADR 0002: Authoritative Required Status Check vs. Formal PR Approval

## Status

Accepted

## Context

Merge Verdict verifies that pull requests satisfy all configured automated review, thread resolution, and CI requirements before merge. GitHub provides two primary primitives for gating merges under branch protection and repository rulesets:

1. **Required Status Checks**: Gating based on the Commit Status API (`POST /statuses/{sha}`) or the Checks API (`POST /check-runs`). When configured as a required check, merging is blocked unless the latest commit on the pull request has a successful check matching the required context name and expected GitHub App source.
2. **Formal Pull Request Approvals**: Gating based on the Pull Request Review API (`POST /pulls/{number}/reviews` with event `APPROVE`). When configured under branch protection, merging requires a minimum number of approving reviews from eligible reviewers.

We must decide which mechanism serves as the authoritative automated merge gate and how the two mechanisms interact.

### Reliability Comparison

| Property                                         | Required Status Check (Checks API)                      | Formal PR Approval                                  |
| :----------------------------------------------- | :------------------------------------------------------ | :-------------------------------------------------- |
| Bound to a commit                                | Yes, strictly via `head_sha`                            | Yes, recorded via `commit_id`                       |
| Blocks merging when absent or failing            | Yes, when configured as required check                  | Only if qualifying human/bot reviews are required   |
| Records verification evidence                    | Structured Markdown, metrics, annotations, external URL | Review body text only                               |
| Records unresolved findings                      | Summary tables, finding breakdown, permalinks           | Review comments or inline notes                     |
| Automatically invalidated on new commits         | Yes; checks on prior SHAs cannot satisfy latest head    | Depends on "Dismiss stale approvals" branch setting |
| Automatically invalidated by new review comments | No; requires explicit invalidation event                | No; requires explicit dismissal                     |
| Dedicated bot identity                           | Supported; GitHub App selected as expected source       | Supported via GitHub App reviewer identity          |
| Independent human approval                       | No; represents automated policy verdict                 | Potentially conflicts with human review thresholds  |
| Best role                                        | Automated verification gate                             | Review endorsement and audit trail                  |

### Critical Platform Behaviors

Two specific GitHub platform behaviors directly affect this architectural decision:

1. **GitHub Branch Protection Accepts `neutral` and `skipped` as Passing**:
   GitHub branch protection considers check conclusions of `neutral` and `skipped` to satisfy required status checks. Therefore, Merge Verdict must never emit `neutral` or `skipped` for non-passing outcomes. Every non-passing outcome (`FAIL`, `STALE`, `PENDING`, `ERROR`) must be published with a blocking conclusion (`failure` or `action_required`) to prevent premature merge enablement.
2. **Workflow-Triggered Jobs May Not Count as Required PR Checks**:
   An ordinary GitHub Actions workflow triggered via `workflow_dispatch` or `issue_comment` does not automatically register as a required pull request check run unless created explicitly through the GitHub Checks API via a GitHub App token. Using Checks API check runs created under GitHub App identity avoids this workflow trigger limitation.

### The Semantic Staleness Problem

A passing check and an approved review can both become semantically stale without any new commit being pushed. For example:
1. Merge Verdict evaluates commit `abc123f` and publishes success.
2. An automated reviewer (such as CodeRabbit or Sourcery) subsequently posts a critical blocking finding against `abc123f`.
3. The commit SHA has not changed.
4. GitHub has no native reason to invalidate the existing successful status check or approval.

This semantic staleness on unchanged code is the primary correctness challenge Merge Verdict must solve.

## Decision

We designate the **required status check (implemented as a GitHub Checks API check run named `merge-verdict`) as the authoritative merge gate**, and treat the **formal GitHub PR approval review as an optional secondary output**.

### Key Tenets

1. **Required Status Check is Primary**:
   The `merge-verdict` check run communicates _what_ was verified, against _which_ commit, using _what_ evidence. Branch protection rulesets must require this check as a mandatory merge gate.
2. **Formal Approval is Secondary**:
   When policy evaluation succeeds (`PASS`), Merge Verdict may optionally submit a formal GitHub PR review with event `APPROVE` as an endorsement and audit notification. However, repositories must not rely on this approval as their sole automated protection.
3. **Checks API Over Commit Statuses**:
   The publisher must utilize the GitHub Checks API (`POST /repos/{owner}/{repo}/check-runs`) rather than the legacy Commit Status API wherever possible. Check runs provide rich Markdown formatting, status summaries, duration metrics, and file-level annotations, which are critical for auditability.
4. **Fast Invalidation Path**:
   To minimize the race window when new review feedback arrives, the trigger layer must execute a fast invalidation path: immediately setting the `merge-verdict` check run to `in_progress` or non-passing upon receiving any PR update, comment, or review event, before the full evaluation engine begins analysis.
5. **Defense in Depth**:
   Repositories deploying Merge Verdict should also enable GitHub's native "Require conversation resolution before merging" branch protection setting as an independent platform-level safeguard against race conditions.

## Alternatives Evaluated

### Alternative A: Formal PR Approval as the Primary Merge Gate

- **Description**: Rely strictly on submitting an `APPROVE` review via the Pull Request Review API to unlock the merge button under "Require approvals" branch protection.
- **Why Rejected**:
  - PR authors cannot approve their own PRs; if Merge Verdict runs under the same user identity as the PR author, the approval API call fails with HTTP 422.
  - Many organizations enforce branch rules requiring approvals from human organization members or Code Owners; an automated approval from a bot does not satisfy these rules.
  - GitHub does not inherently dismiss approvals when new review comments arrive on unchanged code.
  - Approval review bodies have limited formatting options compared to Checks API reports and cannot surface structured check-run annotations in the PR Checks tab.

### Alternative B: Legacy Commit Status API as Sole Check Mechanism

- **Description**: Rely exclusively on `POST /repos/{owner}/{repo}/statuses/{sha}` with context `merge-verdict`.
- **Why Rejected**:
  - The Commit Status API only allows a 140-character description field and a target URL. It cannot display structured verification tables, finding breakdowns, or file annotations directly within GitHub PR views.
  - Retained as a Tier 1 fallback when running with standard `GITHUB_TOKEN` without GitHub App credentials, but subordinated to the Checks API for Tier 2 deployments.

## Trade-Offs

### Advantages

- **Strict Gating**: Branch protection directly enforces status check success before merge button enablement.
- **Rich Audit Trail**: Detailed evidence reports, finding permalinks pinned to verified commit SHAs, and reviewer completion matrices appear directly in the GitHub PR Checks tab.
- **No Self-Approval Failures**: Bot check runs do not suffer from the self-approval restriction that blocks bot PR approvals on self-authored PRs.
- **Deterministic Dispositions**: Non-passing states are guaranteed to block merges by publishing explicit `failure` or `action_required` conclusions.

### Disadvantages and Mitigations

- **Checks API Permissions**: Creating check runs requires a GitHub App with `checks: write` permissions.
  - _Mitigation_: Tier 1 fallback supports the Commit Status API with default `GITHUB_TOKEN`, while Tier 2 provides full Checks API rich reports.
- **Non-Atomic Race Windows**: An event occurring while an evaluation is underway requires prompt invalidation.
  - _Mitigation_: Fast invalidation path reverts check runs to non-passing states immediately, complemented by GitHub native conversation resolution rules.

## Consequences

1. The publisher subsystem will prioritize `src/publisher/checks-api.ts` with structured Markdown reporting, retaining `src/publisher/commit-status.ts` as a fallback.
2. The policy evaluator will emit structured evidence containing exact `head_sha`, `review_state_digest`, and commit-pinned permalinks.
3. Documentation and setup guides will instruct administrators to require the `merge-verdict` check run in repository branch protection settings.
4. Formal PR approval reviews will remain an optional, configurable feature rather than a mandatory merge prerequisite.

## Reconsideration Triggers

This decision should be reconsidered if:
- GitHub introduces native support for automatic approval dismissal upon new review comments on unchanged commits.
- GitHub introduces an API that unifies review approvals and check runs into a single transactional primitive.
- Branch protection deprecates commit-level status checks in favor of review rules exclusively.
