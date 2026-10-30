# Merge Verdict Verification Policy Specification

## 1. Overview and Core Philosophy

Merge Verdict enforces an evidence-based verification policy before granting pull request approval.

The system does not claim to mathematically prove that code is bug-free. Rather, it guarantees **review reconciliation** and **verification-policy satisfaction**: confirming that all configured automated checks have succeeded, all required reviewers have completed evaluation of the current commit, and no unaddressed blocking concerns remain in the pull request review record.

## 2. Critical Semantic Limitations

It is essential to document what deterministic verification can and cannot guarantee. The engine enforces the following epistemic boundaries:

1. **A Resolved Thread Is Not Proof of a Fix**: A developer or bot marking a GitHub review thread as "resolved" indicates only that the conversation thread was closed. It does not prove the underlying defect was eliminated.
2. **An Outdated Comment Is Not Automatically Resolved**: When a new commit is pushed, GitHub marks comments on modified lines as "outdated". Outdated simply means the diff lines shifted; the logical defect may still persist in the new commit.
3. **Developer Affirmation Is Not Proof**: An author replying "fixed", "done", or "addressed" is conversational evidence, not cryptographic or behavioral proof.
4. **Passing Tests Do Not Prove Finding Resolution**: A unit test suite passing proves only that existing test assertions pass. Unless a specific regression test was added covering the reported issue, passing CI does not imply review findings were addressed.
5. **Reviewer Acknowledgements Are Evidence, Not Infallibility**: Automated reviewer updates (such as Sourcery appending `Addressed in [commit]`) are strong heuristic evidence, but reviewers themselves can misidentify fixes or experience regressions across multi-file edits.

Accordingly, Merge Verdict documentation, commit messages, and status outputs must use precise terminology such as **review reconciliation**, **policy compliance**, and **satisfaction of required criteria**, avoiding unfounded claims of code correctness.

## 3. Required Verification Conditions

A pull request is eligible for a passing verdict (`PASS`) and an official `APPROVE` review if and only if all eight of the following conditions are simultaneously met:

### Condition 1: Required CI Checks Succeeded

Every status check, workflow run, and check run configured in the policy's required checks list (e.g. `ci / test`, `runner / actionlint`, `runner / biome`, `CodeQL`) must report a status of `completed` and a conclusion of `success`.
- `failure`, `timed_out`, `action_required`: Immediate policy failure (`FAIL`).
- `queued`, `in_progress`: Immediate pending status (`PENDING`).
- `neutral`, `skipped`, `cancelled`: Treated as `FAIL` unless explicitly whitelisted in the repository policy.

### Condition 2: Required Reviewers Completed

Every reviewer configured as mandatory (e.g. `coderabbitai`, `sourcery-ai`, `chatgpt-codex-connector`, `deepseek-review`) must have submitted a completed review evaluation for the current PR snapshot.
- A missing reviewer run is treated as `PENDING`, not `PASS`. The system never assumes that the absence of comments indicates approval.
- Rate-limited runs (such as CodeRabbit returning a neutral check with a rate-limit notice) are treated as incomplete/unfulfilled unless an explicit fallback exemption is configured.

### Condition 3: No Unresolved Blocking Review Threads

Every review comment thread must be in state `isResolved: true`.
- If any thread remains unresolved (`isResolved: false`), the policy evaluates the findings within that thread.
- If the thread contains an actionable blocking finding, verification resolves to `FAIL`.
- If the thread is classified as purely advisory or informational under policy, it may be exempted if advisory exemption is explicitly enabled in `.github/merge-verdict.yml`.

### Condition 4: No Outstanding Blocking Review Decisions

No required reviewer may have an active review submission with state `CHANGES_REQUESTED`.
- If a reviewer previously submitted `CHANGES_REQUESTED`, that review must be explicitly superseded by a subsequent `APPROVED` or `COMMENTED` review from that reviewer, or dismissed by an authorized repository administrator.

### Condition 5: Reviewer Freshness (No Stale Evidence)

Every required reviewer result must evaluate the current PR head commit SHA.
- If a reviewer posted a review or summary matching commit `SHA-A`, and a subsequent commit `SHA-B` was pushed, that reviewer's state is considered stale.
- Stale reviewer evaluations must not be used to satisfy reviewer completion requirements.

### Condition 6: Unchanged PR and Review Snapshot

The PR snapshot must remain strictly identical between the beginning of evaluation and the final publication of results.
- If the PR head SHA changes or new comments arrive during evaluation, the evaluation is declared `STALE` and aborted without publishing a passing verdict.

### Condition 7: Error-Free Execution

The verification engine itself must have completed all API queries, normalization routines, and policy checks without unhandled exceptions or network timeouts. Any execution anomaly forces an outcome of `ERROR`.

### Condition 8: Repository-Specific Policy Constraints

Any custom repository rules configured in `.github/merge-verdict.yml` (such as minimum test coverage thresholds, required ticket references, or mandatory human review tags) must be satisfied.

## 4. Finding Severity Classification and Handling

Findings extracted from reviewer comments and check runs are classified into four severity tiers:

| Severity Tier             | Definition and Examples                                                                          | Thread Resolution Required | Blocks PR Approval?                   |
| ------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------- |
| `BLOCKER` / `P0`          | Security vulnerabilities, data corruption, crashes, authentication bypasses, broken contracts.   | Yes                        | Yes (Always blocks)                   |
| `HIGH` / `P1`             | Functional bugs, logic inversions, broken state machines, transaction/sign invariant violations. | Yes                        | Yes (Always blocks)                   |
| `MEDIUM` / `P2`           | Boundary condition edge cases, missing defensive checks, dead branches, minor performance risks. | Yes                        | Yes (Blocks by default, configurable) |
| `LOW` / `P3` / `ADVISORY` | Style observations, documentation typos, speculative suggestions, walkthrough guides, bot tips.  | No                         | No (Informational only)               |

## 5. Stale Review Evaluation Rules

Pull requests frequently evolve through multiple commits. Merge Verdict enforces strict commit-freshness rules:

1. **Commit Invalidation**: Any commit push (`synchronize` event) immediately invalidates previous reviewer approvals and passes.
2. **Reviewer SHA Tracking**: Reviewers that emit commit metadata (such as Codex summary JSON `<!-- codex-review-state:v1 {"commit_sha":"..."} -->`, Sourcery commit hashes, or DeepSeek commit IDs) are checked directly against `pull_request.head.sha`.
3. **Check Run SHA Association**: Check runs published via the GitHub Checks API are tied to specific commit SHAs. A passing check run on an older commit does not satisfy a check requirement on the current head commit.
4. **Outdated Threads**: If a review thread was created on an older commit and GitHub marks it `isOutdated: true`, it is still considered unresolved unless explicitly marked `isResolved: true` or evaluated by semantic verification.

## 6. Optional Semantic Verification Escalation

Deterministic rules handle the vast majority of verification cases. However, edge cases arise where a developer pushes a code commit that modifies the reported code line, but the automated reviewer does not automatically resolve the thread.

When `semantic_verification.enabled: true` is configured:
1. **Escalation Boundary**: Only unresolved threads with actionable findings on modified files are eligible for semantic escalation.
2. **Payload Containment**: The LLM is provided only:
   - The original finding title and description.
   - The file path and line numbers.
   - The Git diff hunk for that file between the finding commit and the current head commit.
   - The developer's resolution comment.
3. **Allowed Verdicts**:
   - `RESOLVED`: Concrete evidence in the diff proves the specific concern described in the finding was addressed.
   - `UNRESOLVED`: The diff does not address the concern, introduces a partial fix, or the issue persists.
   - `NOT_APPLICABLE`: The relevant code was deleted or fundamentally refactored, rendering the original finding obsolete.
   - `UNCERTAIN`: Evidence is ambiguous or insufficient to determine resolution.
4. **Fail-Closed Rule**: Both `UNRESOLVED` and `UNCERTAIN` result in the thread remaining unresolved, blocking PR approval.

## 7. Policy Truth Table / Decision Matrix

The following decision matrix defines the final verdict based on system inputs:

| Case | Required CI Checks  | Required Reviewers Completed  | Unresolved Blocking Threads | Active CHANGES_REQUESTED | Reviewer Results Fresh? | Snapshot Unchanged? | Verdict   | Status Check Output | PR Approval Review |
| ---- | ------------------- | ----------------------------- | --------------------------- | ------------------------ | ----------------------- | ------------------- | --------- | ------------------- | ------------------ |
| 1    | All Success         | All Complete                  | None (All Resolved)         | None                     | Yes                     | Yes                 | `PASS`    | `success`           | Submit `APPROVE`   |
| 2    | Queued / Running    | Any Incomplete                | None                        | None                     | Yes                     | Yes                 | `PENDING` | `pending`           | Withhold           |
| 3    | Any Failed          | All Complete                  | None                        | None                     | Yes                     | Yes                 | `FAIL`    | `failure`           | Withhold           |
| 4    | All Success         | Any Incomplete / Rate-Limited | None                        | None                     | Yes                     | Yes                 | `PENDING` | `pending`           | Withhold           |
| 5    | All Success         | All Complete                  | >= 1 Unresolved             | None                     | Yes                     | Yes                 | `FAIL`    | `failure`           | Withhold           |
| 6    | All Success         | All Complete                  | None                        | >= 1 Active              | Yes                     | Yes                 | `FAIL`    | `failure`           | Withhold           |
| 7    | All Success         | All Complete                  | None                        | None                     | No (Stale SHA)          | Yes                 | `PENDING` | `pending`           | Withhold           |
| 8    | All Success         | All Complete                  | None                        | None                     | Yes                     | No (Race)           | `STALE`   | Abort / Invalidate  | Withhold           |
| 9    | API Error / Timeout | N/A                           | N/A                         | N/A                      | N/A                     | N/A                 | `ERROR`   | `error`             | Withhold           |
