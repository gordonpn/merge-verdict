# GitHub Agentic Workflows prototype

**Status:** source-only prototype, not compiled, installed, exercised, or approved for production.

**Workflow:** [`.github/workflows/merge-verdict-prototype.md`](../../.github/workflows/merge-verdict-prototype.md)

## Goal

Test whether GitHub Agentic Workflows (`gh-aw`) can handle semantic review reconciliation without a dedicated orchestration service. Deterministic CI, exact-commit freshness, and publication remain independent of the agent's judgment.

This is an alternative experiment to the bespoke TypeScript action described by [ADR 0001](../adr/0001-actions-first-architecture.md). The ADR remains authoritative for production until this prototype is tested and a replacement ADR is accepted.

## Separation of responsibility

| Layer | Can write to GitHub? | Responsibilities |
|---|---|---|
| Existing conventional CI workflows | Their ordinary scoped permissions | Typechecking, tests, coverage, lint, static analysis |
| `gh-aw` Copilot agent | No | Inspect PR, review threads, code at exact head commit, produce structured per-thread code evidence and PASS/BLOCK proposal |
| `publish-verdict` custom safe-output job | Yes, with minimal scoped token | Parse agent output, compare exact head SHA and PR updated timestamp, independently validate quoted source lines, verify all review threads are resolved and cited, check blocking reviews and required CI, post commit status, optionally submit APPROVE |
| Human maintainer | Normal repository permissions | Confirm policy, configure branch protection, merge |

The job refuses to approve if any evidence is missing, stale, or unverifiable. A resolved thread alone is **not** proof the code is correct. The agent gives a review assessment; the gate verifies its structural provenance and policy. It cannot mathematically prove the agent's interpretation.

## Current limitations and deliberate defaults

1. **Dry-run by default.** Repository variable `MERGE_VERDICT_ENABLE_APPROVAL` must equal `true` before an `APPROVE` is submitted or a passing commit status is published. Dry run leaves `merge-verdict` pending. Separately, `gh-aw` staged safe outputs must not write anything.
2. **Explicit CI allowlist required.** Repository variable `MERGE_VERDICT_REQUIRED_CHECKS` must contain comma-separated exact check-run names or commit status contexts. Missing configuration fails closed. Do not include `merge-verdict` itself (that would deadlock). Example names from SnapTally: `runner / test,runner / biome,runner / actionlint,runner / codeql`.
3. **Same-repository PRs only.** Fork PRs are intentionally rejected until reviewed and securely supported.
4. **No direct thread-resolution event.** GitHub Actions cannot directly subscribe to the `pull_request_review_thread` webhook. A manual dispatch, adjacent review/comment event, or eventual GitHub App webhook relay is required to refresh status after thread-only changes.
5. **Every thread needs evidence.** Each review thread ID must be cited against code in a currently changed source file. This strict rule intentionally blocks benign/outdated/deleted-file and documentation-only cases. Follow-up experiments should define carefully scoped exceptions instead of silently passing.
6. **No separate reviewer completion adapters yet.** The agent interprets review history, but the deterministic job has no machine-readable enforcement for CodeRabbit rate limits, reviewer run freshness, DeepSeek/PR-Agent completion, or all external review policies. Required CI runs are checked deterministically, and review threads/blocking reviews are checked. This gap must close before production usage.
7. **Review updates can race publication.** The job checks PR SHA and `updated_at` before and shortly after publishing. GitHub does not provide a single atomic compare-and-approve endpoint for an entire review snapshot. Use branch protection, dismiss stale approvals, and treat the commit status as authoritative; instrument and test concurrent events before enabling approval.
8. **Permission and identity caveats.** The prototype uses `GITHUB_TOKEN`. The repository's Actions settings must allow workflows to approve pull requests, and GitHub's review protection rules may not count automated self-workflow approval as a qualifying independent human review. A GitHub App installation token can be added later.
9. **No automatic merge.** Approval is distinct from merging. Keep branch rules requiring independent CI and checks.
10. **Status only appears after a proposal is received.** The first prototype does not install a separate, immediate pending-status listener for the beginning of every review event. Do not mark the check required on production branches until this stale-success window is closed.
11. **No generated lockfile yet.** GitHub runs `.lock.yml`, not the Markdown source alone. Do not assume the source is deployable before successfully compiling and reviewing the generated workflow.

## Compile and dry-run checklist

Use a trusted local working copy of the prototype branch:

```bash
gh extension install github/gh-aw
gh aw version
gh aw compile merge-verdict-prototype
gh aw mcp inspect merge-verdict-prototype
git diff -- .github/workflows/merge-verdict-prototype.lock.yml
```

The CLI may require `gh aw init` or equivalent repository setup on first use. Inspect the official [setup guide](https://github.github.io/gh-aw/) for the installed version. If compilation fails, correct the source to match its actual schema; do not assume this proof-of-concept source has already passed compilation. Commit the generated lockfile alongside the source after review.

For Copilot inference, `copilot-requests: write` uses organization billing when supported; a personal-account fine-grained token supplied as `COPILOT_GITHUB_TOKEN` is the documented alternative. Confirm the account's eligibility and billing before execution.

Set `MERGE_VERDICT_REQUIRED_CHECKS` in repository Actions variables to appropriate, exact check names on the test repo. Initially leave `MERGE_VERDICT_ENABLE_APPROVAL` unset or `false`. Do **not** require `merge-verdict` in the protected branch ruleset yet because a dry run intentionally cannot pass.

Create a disposable PR and test:

- Clean PR with no review threads, all required checks successful: agent must cite at least one current code line; gate leaves pending in dry-run.
- Blocking review thread: gate fails and cannot approve.
- Thread manually resolved without code fix: agent must assess substantive correctness rather than treating resolution as proof.
- Nonmatching evidence excerpt or old SHA: gate fails.
- Pushed commit while agent runs: gate fails as stale.
- PR comment while agent runs: gate should fail if the PR metadata changes; note this timestamp is not an atomic review-state fingerprint.
- Missing/neutral/skipped/failed CI: gate fails closed.
- Change request still in effect: gate fails closed.
- More than one agent `publish_verdict` request: gate refuses ambiguous output.
- Trigger without a specific PR, or from another PR: no-op/refusal.
- Staged safe-output run: **no GitHub writes**.
- Existing prior approval on same SHA: avoid duplicate identical review.
- Repeated comment/check-run events: confirm no unexpected agent loops or runaway inference spend.

Only after the above tests, and after implementing deterministic reviewer-completion and immediate invalidation, enable `MERGE_VERDICT_ENABLE_APPROVAL=true` in a disposable repository. Confirm a valid `APPROVE` review is submitted on the exact current SHA, that branch protection responds to `merge-verdict` as expected, and that later commits/comments invalidate approval promptly.

## Graduation criteria

Keep gh-aw if the prototype reliably parses real CodeRabbit, Sourcery, Codex, DeepSeek Review, and CI outputs with acceptable inference cost and latency, and if a deterministic publication gate can protect stale/racing events.

Fall back to a purpose-built TypeScript action if the agentic workflow cannot cost-effectively normalize the review data, or if event-completeness and state coordination warrant dedicated code.

**Next step:** compile this source, repair schema issues if any, and run a no-write test against a disposable PR resembling [SnapTally #121](https://github.com/gordonpn/snaptally/pull/121). Do not add an orchestration service during this experiment.

## Official references

- [GitHub Agentic Workflows](https://github.github.io/gh-aw/)
- [Custom safe outputs](https://github.github.io/gh-aw/reference/custom-safe-outputs/)
- [Triggers](https://github.github.io/gh-aw/reference/triggers/)
- [Authentication](https://github.github.io/gh-aw/reference/auth/)
- [GitHub Commit Statuses API](https://docs.github.com/en/rest/commits/statuses)
- [Pull Request Reviews API](https://docs.github.com/en/rest/pulls/reviews)
