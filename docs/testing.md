# Testing and Verification Strategy

## 1. Testing Philosophy and Verification Hierarchy

Merge Verdict is a critical infrastructure component that governs repository branch protection and pull request merges. A defect in Merge Verdict could either block all developer merges (false negative) or permit unreviewed code with critical flaws into production (false positive).

Therefore, testing is organized around strict verification tiers:
1. **Deterministic Unit Tests**: Pure function tests for parsing, normalization, state fingerprinting, and policy decisions. Run with zero network access and execute in milliseconds.
2. **Fixture Replay Tests**: Full engine runs executed against recorded, anonymized GitHub REST and GraphQL response payloads taken directly from real PRs (such as SnapTally PRs #119, #120, and #121).
3. **Simulated Concurrency and Race Condition Tests**: Verifying that atomic pre-flight checks, state fingerprinting, and `cancel-in-progress` concurrency controls prevent stale approvals when events arrive out of order or concurrently.
4. **Integration Tests (GitHub Environment)**: Live end-to-end tests in a dedicated sandbox repository verifying branch protection enforcement, real check run publication, and genuine PR review approvals.

## 2. Test Fixtures from Reference PRs (SnapTally)

Testing leverages recorded fixtures from real-world pull requests in `gordonpn/snaptally`:

### Fixture Set A: Multi-Reviewer Resolution (SnapTally PR #119)
- **Characteristics**:
  - CodeRabbit check run returns `conclusion: "neutral"` due to free-tier rate limits.
  - Sourcery raises high-severity finding `Previous defaults carry over`, followed by commit `6d2d457...`, comment edit `Addressed in 6d2d457...`, and thread resolution by `sourcery-ai[bot]`.
  - Codex connector raises finding on Income sign invariant (`<!-- codex-code-review-finding:v1 -->`), resolved by developer commit `c51f37d...`.
  - All CI workflows (`runner / test`, `runner / biome`, `runner / actionlint`, `CodeQL`, `codecov`) complete successfully.
- **Test Assertion**:
  - Verifies that Sourcery bot thread resolution with matching commit SHA is recognized.
  - Verifies that rate-limited CodeRabbit check fails policy unless rate-limit exemptions are enabled in configuration.

### Fixture Set B: Stale Review Commit Detection (SnapTally PR #120)
- **Characteristics**:
  - Pull request head commit is `35c286dc84db8dc22ffd3e58b3457a1c77acb019`.
  - Codex summary comment records: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"a895efe284efc2ebf1ef2894c9a093af929cd98f",...}} -->`.
  - All review threads resolved; all CI checks passing on `35c286d...`.
- **Test Assertion**:
  - The policy engine flags Codex review status as `STALE`.
  - If Codex is configured as a mandatory reviewer, overall verdict is `PENDING`, withholding approval until Codex evaluates `35c286d...`.

### Fixture Set C: Reviewer Commit Divergence & Minor Findings (SnapTally PR #121)
- **Characteristics**:
  - DeepSeek Review submits review on commit `6ad1952...` with `Verdict: APPROVE WITH MINOR FINDINGS`.
  - Final PR commit is `ce22a74...`.
  - PR-Agent posts ticket compliance analysis table.
  - 11 review threads, all marked resolved.
- **Test Assertion**:
  - Engine parses DeepSeek textual verdict correctly.
  - Flags DeepSeek review as stale relative to commit `ce22a74...`.

## 3. Specific Edge Cases and Failure Scenarios

The test suite must explicitly cover the following edge cases:

### 3.1. Reviewer Rate Limiting
- **Scenario**: Reviewer check run returns status `completed` with conclusion `neutral` and body containing rate-limit warnings.
- **Expected Outcome**: Engine categorizes reviewer as `RATE_LIMITED`. Does not treat neutral check as passing. PR approval is withheld.

### 3.2. Conflicting Reviewer Conclusions
- **Scenario**: Reviewer A (e.g. Sourcery) submits an approval or resolves threads, while Reviewer B (e.g. DeepSeek) submits `REQUEST CHANGES` or `BLOCK`.
- **Expected Outcome**: Blocking decision rule triggers; verdict is `FAIL`. Approval withheld.

### 3.3. Outdated Comments on Modified Files
- **Scenario**: A comment was posted on line 45. A new commit is pushed modifying line 45. GitHub marks the thread `isOutdated: true`, but `isResolved` remains `false`.
- **Expected Outcome**: Outdated status alone is not treated as resolved. The thread remains blocking unless marked resolved or validated by semantic verification.

### 3.4. Pre-Flight Race Condition (Head SHA Mutated Mid-Run)
- **Scenario**: Evaluation starts for commit `SHA-1`. While the engine is evaluating policies, a developer pushes commit `SHA-2`. Pre-flight check queries `current_head_sha` and discovers mismatch.
- **Expected Outcome**: Execution aborts immediately with status `STALE`. No success status check or approval is posted for `SHA-1`.

### 3.5. Late-Arriving Comment During Run
- **Scenario**: Evaluation starts for commit `SHA-1`. A reviewer posts an unresolved blocking comment while policies are being computed.
- **Expected Outcome**: State fingerprint check detects comment count mismatch. Execution aborts, allowing the newly triggered workflow run to evaluate the updated comment set.

### 3.6. Partial Publication Failure
- **Scenario**: Status check publication (`POST /statuses/{sha}`) succeeds, but PR review submission fails due to a network glitch.
- **Expected Outcome**: Process exits with code 1. Branch protection remains enforced because the status check is the authoritative gate. Subsequent workflow retry succeeds in posting the review.

### 3.7. Fork Security and Privilege Escalation
- **Scenario**: PR submitted from external fork contains modified `.github/merge-verdict.yml` relaxing approval rules.
- **Expected Outcome**: For fork PRs, configuration is loaded exclusively from the target base branch (e.g. `main`), ignoring changes in the fork.

## 4. Replay Test Plan (Zero External API Calls)

To enable rapid local development and automated CI testing without incurring external API costs or network flakiness, Merge Verdict implements an offline replay test suite:

```typescript
import { describe, it, expect } from "vitest";
import { MockGitHubClient } from "../mocks/mock-github-client";
import { evaluatePullRequest } from "../../src/policy/evaluator";
import pr120Fixture from "../fixtures/snaptally-pr120.json";

describe("Offline Replay: SnapTally PR #120", () => {
  it("withholds approval due to stale Codex review commit", async () => {
    const mockClient = new MockGitHubClient(pr120Fixture);
    const result = await evaluatePullRequest(mockClient, {
      requiredReviewers: ["chatgpt-codex-connector", "sourcery-ai"],
      requiredChecks: ["runner / test", "runner / biome"]
    });

    expect(result.verdict).toBe("PENDING");
    expect(result.reviewers["chatgpt-codex-connector"].status).toBe("STALE");
    expect(result.canApprove).toBe(false);
  });
});
```

## 5. Live Integration Test Plan (Sandbox Environment)

For validating live platform interactions before major releases:

1. **Repository Setup**: A dedicated test repository with branch protection requiring status check `merge-verdict` and 1 approving review.
2. **Scenario 1 - Negative Path**: Open PR with broken CI and unresolved threads. Assert `merge-verdict` reports `failure` and GitHub blocks merging.
3. **Scenario 2 - Positive Path**: Fix CI, resolve all threads, simulate reviewer approvals. Assert `merge-verdict` reports `success`, an official `APPROVE` review is posted, and GitHub unlocks the merge button.
4. **Scenario 3 - Commit Invalidation**: Push new commit to previously approved PR. Assert `merge-verdict` reverts to `pending` and approval is invalidated.
