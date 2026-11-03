# Merge Verdict Verification Policy Specification

## 1. Overview and Core Philosophy

Merge Verdict enforces an evidence-based verification policy before granting pull request approval.

The system does not claim to mathematically prove that code is bug-free. Rather, it guarantees **review reconciliation** and **verification-policy satisfaction**: confirming that all configured automated checks have succeeded, all required reviewers have completed evaluation of the current commit, and no unaddressed blocking concerns remain in the pull request review record.

As established in [ADR 0002: Authoritative Required Status Check vs. Formal PR Approval](docs/adr/0002-authoritative-status-check-vs-pr-approval.md), Merge Verdict designates the **required status check (Checks API check run named `merge-verdict`) as the authoritative merge gate**, and treats the **formal GitHub PR review approval as an optional secondary output**. A required check communicates _what_ was verified, against _which_ commit, using _what_ evidence. An approval records _who_ endorsed the changes.

## 2. Critical Semantic Limitations and Semantic Staleness

It is essential to document what deterministic verification can and cannot guarantee. The engine enforces the following epistemic boundaries:

1. **A Resolved Thread Is Not Proof of a Fix**: A developer or bot marking a GitHub review thread as "resolved" indicates only that the conversation thread was closed. It does not prove the underlying defect was eliminated.
2. **An Outdated Comment Is Not Automatically Resolved**: When a new commit is pushed, GitHub marks comments on modified lines as "outdated". Outdated simply means the diff lines shifted; the logical defect may still persist in the new commit.
3. **Developer Affirmation Is Not Proof**: An author replying "fixed", "done", or "addressed" is conversational evidence, not cryptographic or behavioral proof.
4. **Passing Tests Do Not Prove Finding Resolution**: A unit test suite passing proves only that existing test assertions pass. Unless a specific regression test was added covering the reported issue, passing CI does not imply review findings were addressed.
5. **Reviewer Acknowledgements Are Evidence, Not Infallibility**: Automated reviewer updates (such as Sourcery appending `Addressed in [commit]`) are strong heuristic evidence, but reviewers themselves can misidentify fixes or experience regressions across multi-file edits.
6. **Semantic Staleness on Unchanged Commits**: A passing check and an approved review can both become semantically stale without any new commit being pushed. For example:
   - Merge Verdict evaluates commit `abc123f` and publishes success.
   - An automated reviewer (such as CodeRabbit or Sourcery) subsequently posts a critical blocking finding against `abc123f`.
   - The commit SHA has not changed.
   - GitHub has no native reason to invalidate the existing successful status check.
   - Merge Verdict must actively handle this by executing immediate invalidation whenever new review events arrive.

Accordingly, Merge Verdict documentation, commit messages, and status outputs must use precise terminology such as **review reconciliation**, **policy compliance**, and **satisfaction of required criteria**, avoiding unfounded claims of code correctness.

## 3. Required Verification Conditions

A pull request is eligible for a passing verdict (`PASS`) and a successful `merge-verdict` check run if and only if all eight of the following conditions are simultaneously met:

### Condition 1: Required CI Checks Succeeded

Every status check, workflow run, and check run configured in the policy's required checks list (e.g. `ci / test`, `runner / actionlint`, `runner / biome`, `CodeQL`) must report a status of `completed` and a conclusion of `success` (or an explicitly permitted conclusion such as `neutral` or `skipped` when configured in repository policy).
- `failure`, `timed_out`, `action_required`: Immediate policy failure (`FAIL`).
- `queued`, `in_progress`: Immediate pending status (`PENDING`).
- `neutral`, `skipped`, `cancelled`: Treated as `FAIL` unless explicitly permitted in repository configuration.

> [!IMPORTANT]
> **Critical GitHub Platform Behavior Regarding `neutral` and `skipped` Conclusions:**
> GitHub branch protection considers `neutral` and `skipped` conclusions acceptable for required checks. Therefore, Merge Verdict must publish conclusion `success` only for an actual policy pass, and must use an explicit blocking conclusion (`failure` or `action_required`) for every other terminal outcome (`FAIL`, `STALE`, `ERROR`, or unfulfilled checks). Publishing `neutral` or `skipped` would allow GitHub branch protection to permit merging without verification.

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

## 4. Required Status Check vs. Formal PR Approval

### 4.1. Reliability Comparison

| Dimension                               | Required Check (Checks API)                                      | Formal PR Review Approval                         |
| :-------------------------------------- | :--------------------------------------------------------------- | :------------------------------------------------ |
| Enforcing automated criteria            | Explicit success/failure result enforced by branch protection    | Only if qualifying human/bot reviews are required |
| Evidence and auditability               | Structured report, annotations, commit-pinned links              | Plain review body text                            |
| Human accountability                    | Automated system verification record                             | Reviewer identity endorsing changes               |
| Handling later code changes             | Automatically invalidates (prior SHA checks do not satisfy head) | Depends on "Dismiss stale approvals" setting      |
| Handling new comments on unchanged code | Requires explicit invalidation                                   | Requires explicit dismissal                       |
| Independence from AI decisions          | Deterministic gate remains authoritative                         | Can be conflated with LLM approval                |

### 4.2. What the Required Check Records

Merge Verdict uses the GitHub Checks API (`POST /repos/{owner}/{repo}/check-runs`) created under GitHub App identity rather than simple commit statuses. Check runs provide rich Markdown summaries, detailed finding sections, metrics, and file-level annotations directly within the GitHub PR Checks tab.

An illustrative check report rendered in the PR Checks tab:

```markdown
### merge-verdict / review-reconciliation

**Verdict:** Failure
- Unresolved threads: 2
- Resolved threads: 8
- Required CI: 4/4
- Verified PR head: `abc123f498c181b234567890abcdef1234567890`

#### Outstanding Concerns

- **Thread #1 - Possible race condition**
  `src/sync/queue.ts:84`
  The new code does not establish that concurrent retries are serialized.
- **Thread #2 - Missing regression test**
  `tests/sync.test.ts:121`
  No test demonstrates recovery after an interrupted retry.

#### Verified CI Evidence

- Unit tests: passed (48 tests)
- Typecheck: passed
- Biome linter: passed
- CodeQL: passed
```

### 4.3. Persisted Machine-Readable Verification Evidence Schema

In addition to human-readable Markdown output, every check run persists a structured machine-readable JSON payload in the check run `output.text` or attached artifact:

```json
{
  "repository": "gordonpn/merge-verdict",
  "prNumber": 18,
  "headSha": "fae800c4bf2c14072460e4b2a1790f29c96385a9",
  "reviewStateDigest": "9d8e7f6a5b4c3d2e1f0a...",
  "policyVersion": "abce24b54d40470d402f8052c31c5a2f0e0dc0a8",
  "capturedAt": "2026-11-02T18:00:00.000Z",
  "findings": [
    {
      "threadId": "PRRT_kwDOVb9FLs6yKYmE",
      "reviewerId": "chatgpt-codex-connector",
      "severity": "MEDIUM",
      "isResolved": true,
      "sourcePermalink": "https://github.com/gordonpn/merge-verdict/blob/fae800c4bf2c14072460e4b2a1790f29c96385a9/src/models/snapshot.ts#L77",
      "explanation": "Resolved in commit fae800c"
    }
  ],
  "checkRuns": [
    {
      "id": "124350115197",
      "name": "CodeRabbit",
      "conclusion": "neutral",
      "evaluatedSha": "fae800c4bf2c14072460e4b2a1790f29c96385a9",
      "runUrl": "https://github.com/gordonpn/merge-verdict/runs/124350115197"
    }
  ],
  "semanticVerification": {
    "invoked": false,
    "model": null,
    "durationMs": 0
  }
}
```

Permalinks must always be pinned to the verified 40-character commit SHA, never to moving branch refs.

### 4.4. Approval as an Optional Secondary Output

When verification passes (`PASS`), the formal approval review submitted by Merge Verdict is compact and refers directly to the authoritative check run:

> Merge Verdict approved commit `abc123f` after reconciling 10 review threads and verifying four required CI checks. See the linked verification report for supporting evidence.

Reasons formal PR approval is secondary rather than primary:
- GitHub prevents PR authors from approving their own pull requests (API returns HTTP 422).
- Many organizations mandate approvals from specific human Code Owners; automated bot reviews cannot satisfy these requirements.
- Approval invalidation upon new commits depends on repository settings ("Dismiss stale approvals").
- New review comments on unchanged commits do not natively dismiss existing approvals.

## 5. Fast Invalidation Path and Lifecycle Management

To close the race window where a previously passing check run could be used to merge code after new review comments arrive:

1. **Fast Invalidation Path**:
   Upon receiving any PR update, comment, or review event, the trigger layer immediately updates the `merge-verdict` check run status to `in_progress` or non-passing before launching the full evaluation engine or optional semantic models.
2. **Deterministic Evaluation**:
   The engine collects snapshot data, computes the state fingerprint, normalizes findings, and evaluates policy conditions.
3. **Pre-Publication Revalidation**:
   The engine re-verifies that the head SHA and review state fingerprint match the initial snapshot.
4. **Final Publication**:
   - If verdict is `PASS`: update check run status to `completed` with conclusion `success` (or commit status state `success`), and optionally submit `APPROVE` review.
   - If verdict is `PENDING`: update or maintain check run status as `in_progress` with conclusion `null` (or commit status state `pending`), withholding approvals while awaiting in-flight CI runs or reviewer evaluations.
   - If verdict is `FAIL` or `ERROR`: update check run status to `completed` with conclusion `failure` or `action_required` (or commit status state `failure` or `error`), and dismiss any prior approval review.
   - If verdict is `STALE`: discard the evaluation run without publishing or updating check status, preventing an obsolete concurrent run from overwriting newer in-progress workflow evaluations.
5. **Defense in Depth**:
   Repositories should enable GitHub's native "Require conversation resolution before merging" branch protection setting as an independent safeguard against race conditions.

## 6. Synthetic Merge Commits and Merge Queue Integration

When repositories use GitHub Merge Queues:
- GitHub creates a synthetic test-merge commit (`refs/pull/123/merge` or temporary merge queue ref) combining the PR branch with target `main`.
- Workflows triggered by `merge_group` evaluate this synthetic merge commit SHA rather than the PR branch head SHA.
- Merge Verdict detects whether the triggering event is a standard pull request or a `merge_group` event, binding its snapshot verification and status check to the corresponding target SHA.

## 7. Version-Controlled Policy Authority

All verification policies, required checks, mandatory reviewers, and severity exemptions must reside in version control (specifically `.github/merge-verdict.yml`).
- Inferred developer preferences or observed patterns must never silently weaken verification gates.
- Any change to review standards or blocking conditions must occur via an explicit, reviewable commit or pull request to the repository configuration.
- The policy evaluator records the `policyVersion` commit SHA in every check report for full traceability.

## 8. Finding Severity Classification and Handling

Findings extracted from reviewer comments and check runs are classified into four severity tiers:

| Severity Tier             | Definition and Examples                                                                          | Thread Resolution Required | Blocks PR Approval?                   |
| :------------------------ | :----------------------------------------------------------------------------------------------- | :------------------------- | :------------------------------------ |
| `BLOCKER` / `P0`          | Security vulnerabilities, data corruption, crashes, authentication bypasses, broken contracts.   | Yes                        | Yes (Always blocks)                   |
| `HIGH` / `P1`             | Functional bugs, logic inversions, broken state machines, transaction/sign invariant violations. | Yes                        | Yes (Always blocks)                   |
| `MEDIUM` / `P2`           | Boundary condition edge cases, missing defensive checks, dead branches, minor performance risks. | Yes                        | Yes (Blocks by default, configurable) |
| `LOW` / `P3` / `ADVISORY` | Style observations, documentation typos, speculative suggestions, walkthrough guides, bot tips.  | No                         | No (Informational only)               |

## 9. Stale Review Evaluation Rules

Pull requests frequently evolve through multiple commits. Merge Verdict enforces strict commit-freshness rules:

1. **Commit Invalidation**: Any commit push (`synchronize` event) immediately invalidates previous reviewer approvals and passes.
2. **Reviewer SHA Tracking**: Reviewers that emit commit metadata (such as Codex summary JSON `<!-- codex-review-state:v1 {"commit_sha":"..."} -->`, Sourcery commit hashes, or DeepSeek commit IDs) are checked directly against `pull_request.head.sha`.
3. **Check Run SHA Association**: Check runs published via the GitHub Checks API are tied to specific commit SHAs. A passing check run on an older commit does not satisfy a check requirement on the current head commit.
4. **Outdated Threads**: If a review thread was created on an older commit and GitHub marks it `isOutdated: true`, it is still considered unresolved unless explicitly marked `isResolved: true` or evaluated by semantic verification.

## 10. Optional Semantic Verification Escalation

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

## 11. Policy Truth Table / Decision Matrix

The following decision matrix defines the final verdict based on system inputs:

| Case | Required CI Checks  | Required Reviewers Completed  | Unresolved Blocking Threads | Active CHANGES_REQUESTED | Reviewer Results Fresh? | Snapshot Unchanged? | Verdict   | Check Run Status | Check Run Conclusion | Commit Status State | PR Approval Review |
| :--- | :------------------ | :---------------------------- | :-------------------------- | :----------------------- | :---------------------- | :------------------ | :-------- | :--------------- | :------------------- | :------------------ | :----------------- |
| 1    | All Success         | All Complete                  | None (All Resolved)         | None                     | Yes                     | Yes                 | `PASS`    | `completed`      | `success`            | `success`           | Submit `APPROVE`   |
| 2    | Queued / Running    | Any Incomplete                | None                        | None                     | Yes                     | Yes                 | `PENDING` | `in_progress`    | `null`               | `pending`           | Withhold           |
| 3    | Any Failed          | All Complete                  | None                        | None                     | Yes                     | Yes                 | `FAIL`    | `completed`      | `failure`            | `failure`           | Withhold / Dismiss |
| 4    | All Success         | Any Incomplete / Rate-Limited | None                        | None                     | Yes                     | Yes                 | `PENDING` | `in_progress`    | `null`               | `pending`           | Withhold           |
| 5    | All Success         | All Complete                  | >= 1 Unresolved             | None                     | Yes                     | Yes                 | `FAIL`    | `completed`      | `failure`            | `failure`           | Withhold / Dismiss |
| 6    | All Success         | All Complete                  | None                        | >= 1 Active              | Yes                     | Yes                 | `FAIL`    | `completed`      | `failure`            | `failure`           | Withhold / Dismiss |
| 7    | All Success         | All Complete                  | None                        | None                     | No (Stale SHA)          | Yes                 | `PENDING` | `in_progress`    | `null`               | `pending`           | Withhold           |
| 8    | All Success         | All Complete                  | None                        | None                     | Yes                     | No (Race)           | `STALE`   | `DiscardRun`     | `null`               | Discard (No-op)     | Withhold / Abort   |
| 9    | API Error / Timeout | N/A                           | N/A                         | N/A                      | N/A                     | N/A                 | `ERROR`   | `completed`      | `failure`            | `error`             | Withhold / Dismiss |
