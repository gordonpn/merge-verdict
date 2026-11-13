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

Three specific GitHub platform behaviors directly affect this architectural decision:

1. **GitHub Branch Protection Accepts `neutral` and `skipped` as Passing**:
   GitHub branch protection considers check conclusions of `neutral` and `skipped` to satisfy required status checks. Therefore, Merge Verdict must never emit `neutral` or `skipped` for non-passing outcomes. Every terminal non-passing outcome (`FAIL`, `STALE`, `ERROR`) must be published with a blocking conclusion (`failure` or `action_required`) to prevent premature merge enablement. `PENDING` remains an in-progress check run with conclusion `null`.
2. **Workflow-Triggered Jobs May Not Count as Required PR Checks**:
   A workflow triggered via `workflow_dispatch` or `issue_comment` must not assume its default workflow SHA is the PR head. Merge Verdict explicitly creates or updates its check run on the event evaluation SHA using credentials authorized for the Checks API. Branch protection must require that check name and the intended source App.
3. **GitHub Copilot's Native Approval Privilege Does Not Generalize to Third-Party Apps**:
   GitHub introduced native Copilot pull request approvals (`copilot-pull-request-reviewer[bot]`) with general availability in October 2026, allowing Copilot `APPROVE` reviews to count toward required-review branch protection rules when enabled by administrators. However, this merge-approval privilege is specific to GitHub Copilot; arbitrary third-party GitHub Apps (such as `merge-verdict[bot]`) do not automatically receive the same special treatment under human or Code Owner review requirements. Furthermore, Copilot approvals are dismissed on new commits, but are not invalidated when external reviewers post new blocking findings on an unchanged commit SHA.

### The Semantic Staleness Problem

A passing check and an approved review can both become semantically stale without any new commit being pushed. For example:
1. Merge Verdict evaluates commit `abc123f` and publishes success.
2. An automated reviewer (such as CodeRabbit or Sourcery) subsequently posts a critical blocking finding against `abc123f`.
3. The commit SHA has not changed.
4. GitHub has no native reason to invalidate the existing successful status check or approval.

This semantic staleness on unchanged code is the primary correctness challenge Merge Verdict must solve.

## Decision

We designate the **required status check (implemented as a GitHub Checks API check run named `merge-verdict`) as the authoritative merge gate**, paired with **formal GitHub PR approval reviews (`APPROVE`) as a mandatory core review endorsement** managed through an explicit approval-provider abstraction (`github_copilot` or `github_app`, with `none` available only when repositories explicitly disable approval emission for specific high-risk paths requiring human review).

### Key Tenets

1. **Required Status Check is Primary**:
   The `merge-verdict` check run communicates _what_ was verified, against _which_ commit, using _what_ evidence. Branch protection rulesets must require this check as a mandatory merge gate.
2. **Separate Verification Verdict, Approval Emission, and Merge-Rule Recognition**:
   Merge Verdict strictly separates:
   - The deterministic verification assessment (`PASS`, `PENDING`, `FAIL`, `STALE`, `ERROR`),
   - Whether the configured policy and path-based risk tier permit issuing or requesting an automated approval, and
   - Whether GitHub branch protection actually recognizes that approval as satisfying required-review thresholds.
     When policy evaluation succeeds (`PASS`) and the matched path risk tier allows automated approval, Merge Verdict delegates approval submission to a configurable provider (`github_copilot` or `github_app`). Repositories must always pair the approval review with the authoritative `merge-verdict` check run rather than relying on formal approval alone.
3. **Checks API Over Commit Statuses**:
   The publisher must utilize the GitHub Checks API (`POST /repos/{owner}/{repo}/check-runs`) rather than the legacy Commit Status API. There is no supported Commit Status API publishing fallback for the authoritative gate. Check runs provide rich Markdown formatting, status summaries, duration metrics, and file-level annotations, which are critical for auditability.
4. **Fast Invalidation Path**:
   To minimize the race window when new review feedback arrives, the trigger layer must execute a fast invalidation path: immediately setting the `merge-verdict` check run to `in_progress` or non-passing upon receiving any PR update, comment, or review event, before the full evaluation engine begins analysis.
5. **Base-Branch Policy Authority and Defense in Depth**:
   Unlike tools that read instructions from the untrusted PR head branch, Merge Verdict always evaluates `.github/merge-verdict.yml` from the protected base branch revision. Repositories deploying Merge Verdict should also enable GitHub's native "Require conversation resolution before merging" branch protection setting as an independent platform-level safeguard against race conditions.

### Trade-Offs Across Publication Strategies

| Approach                                                  | Main Benefit                                                         | Main Limitation                                                                                             |
| :-------------------------------------------------------- | :------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| Native Copilot approval only                              | Minimal implementation; GitHub-recognized approval                   | Does not reconcile external reviewers or independently enforce CI evidence; blind to comment-only staleness |
| Merge Verdict check + Copilot approval (`github_copilot`) | Strong separation of multi-reviewer verification and review sign-off | Depends on Copilot entitlement, repository settings, and review execution                                   |
| Merge Verdict check + own App approval (`github_app`)     | Vendor-neutral, dedicated bot identity                               | Third-party App approval may not satisfy required human or Code Owner review rules                          |
| Merge Verdict check only (`none`)                         | Simplest reliable automated enforcement                              | Emits no formal PR approval review                                                                          |

When GitHub Copilot is available and enabled, combining the required `merge-verdict` check run with the `github_copilot` approval provider offers native approval recognition alongside multi-reviewer reconciliation. When Copilot is unavailable, `github_app` or `none` provides a vendor-neutral fallback without weakening the authoritative check gate.

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
  - A legacy status with the same name is not a substitute for the required check run. Missing Checks API authorization is a setup error, not permission to publish a different gate.

## Trade-Offs

### Advantages

- **Strict Gating**: Branch protection directly enforces status check success before merge button enablement.
- **Rich Audit Trail**: Detailed evidence reports, finding permalinks pinned to verified commit SHAs, and reviewer completion matrices appear directly in the GitHub PR Checks tab.
- **No Self-Approval Failures**: Bot check runs do not suffer from the self-approval restriction that blocks bot PR approvals on self-authored PRs.
- **Deterministic Dispositions**: Non-passing states are guaranteed to block merges by publishing explicit `failure` or `action_required` conclusions.

### Disadvantages and Mitigations

- **Checks API Permissions**: Creating check runs requires credentials authorized for the Checks API with effective `checks: write` permission.
  - _Mitigation_: Configure an authorized trusted workflow token or a dedicated GitHub App installation token. Verify effective event permissions and the expected source App before rollout; if publication fails, report an error and withhold approval. See [GitHub check-run authentication](https://docs.github.com/en/rest/checks/runs#create-a-check-run) and [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).
- **Non-Atomic Race Windows**: An event occurring while an evaluation is underway requires prompt invalidation.
  - _Mitigation_: Fast invalidation path reverts check runs to non-passing states immediately, complemented by GitHub native conversation resolution rules.

## Consequences

1. The publisher subsystem will implement `src/publisher/checks-api.ts` with structured Markdown reporting from Milestone 2. Dedicated App token minting and richer reporting extend this publisher in Milestone 3; no legacy commit-status publisher is part of the supported gate.
2. The policy evaluator will emit structured evidence containing exact `head_sha`, `review_state_digest`, and commit-pinned permalinks.
3. Documentation and setup guides will instruct administrators to require the `merge-verdict` check run in repository branch protection settings.
4. Formal PR approval reviews (`APPROVE`) are emitted alongside the `merge-verdict` check run when verification passes and path risk-tier eligibility is satisfied, while the required check run serves as the non-bypassable merge gate.

## Reconsideration Triggers

This decision should be reconsidered if:
- GitHub introduces native support for automatic approval dismissal upon new review comments on unchanged commits.
- GitHub introduces an API that unifies review approvals and check runs into a single transactional primitive.
- Branch protection deprecates commit-level status checks in favor of review rules exclusively.
