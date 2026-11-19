# Project Execution Queue

Repository: [gordonpn/merge-verdict](https://github.com/gordonpn/merge-verdict)

Snapshot: 2026-11-19 UTC, main at `66595afe1d8468ee2e2f8cfca2de5b762ba5a8ec`. GitHub Issues remain authoritative. The scan found 28 open issues and zero open PRs. Later changes require a fresh query.

## NOW

### [#73: Complete the first manual advisory validation](https://github.com/gordonpn/merge-verdict/issues/73)

- Priority: P1. Effort: M. Readiness: in progress; normalizer and workflow gating fixes (PRs #115, #117, #120, #121, #122) and `required_reviewers: [deepseek-review]` in [`.github/merge-verdict.yml`](.github/merge-verdict.yml) (PR #130) are merged on `main`.
- Reason: Remaining prerequisite for automatic advisory refresh and a second repository trial. ERROR, STALE, PENDING, and repeated publication have dated evidence in the issue; clean PASS awaits live DeepSeek Review execution on an open PR.
- First action: With `ENABLE_DEEPSEEK_REVIEW` and `DEEPSEEK_API_KEY` provisioned, post an authorized `/review` comment on the selected open, non-draft PR and wait for DeepSeek Review to complete on its exact head. Then dispatch the Merge Verdict workflow for that PR and inspect the resulting verdict.
- Done: Record clean PASS, invalid-input summary-only failure, repeat invocation, and sanitized regression evidence without enabling approvals or changing branch protection.
- Unblocks: [#74](https://github.com/gordonpn/merge-verdict/issues/74) and [#75](https://github.com/gordonpn/merge-verdict/issues/75).

### Independent code and normalizer items ready now

1. [#132: Validate required_reviewers entries against registered normalizer IDs](https://github.com/gordonpn/merge-verdict/issues/132), P2/XS: add repository policy verification confirming `.github/merge-verdict.yml` entries exist in `DEFAULT_REVIEWER_NORMALIZERS` without restricting generic schema consumers.
2. [#126: Distinguish Codex review quota failures](https://github.com/gordonpn/merge-verdict/issues/126), P2/S: classify verified current-revision `chatgpt-codex-connector` quota exhaustion as `RATE_LIMITED` rather than `FAILED`, matching Copilot and Sourcery handling.
3. [#131: Implement PR-Agent review and ticket compliance adapter](https://github.com/gordonpn/merge-verdict/issues/131), P2/M: add `src/normalizers/pr-agent.ts`, register it in `DEFAULT_REVIEWER_NORMALIZERS`, and cover review and ticket compliance states with fixture tests.

## NEXT

1. [#128: Evaluate rate limit timeout exemptions for required reviewers](https://github.com/gordonpn/merge-verdict/issues/128), P2/S: wire `rateLimitTimeoutMinutes` and `allowAdvisoryExemptions` evaluation in `src/policy/evaluator.ts` so expired rate limits transition to `EXEMPT` while active ones hold `PENDING`.
2. [#127: Live validation of credential-backed PR-Agent and DeepSeek Review execution](https://github.com/gordonpn/merge-verdict/issues/127), P2/S: verify `deepseek-review.yml` and `pr-agent.yml` with `ENABLE_*` variables and `DEEPSEEK_API_KEY`, exercise slash commands (`/review`, `/describe`, `/improve`, `/ask`), and reconcile hard credential checks.
3. [#78: Optional reviewer origin validation](https://github.com/gordonpn/merge-verdict/issues/78), P2/S: static guard inspection is recorded in [docs/reviewer-workflow-validation.md](docs/reviewer-workflow-validation.md) (PR #124) and gating landed in PR #120; live origin, cancellation, and fork trust-boundary trials remain pending.
4. [#26: Remaining normalizer boundary support](https://github.com/gordonpn/merge-verdict/issues/26), P2/S: unblocked after PRs #121 and #122; cover multiline diff ranges, deleted or renamed files, and file-level comments without line numbers in `tests/normalizers/boundaries.test.ts`.
5. [#57: Issue-link product decisions](https://github.com/gordonpn/merge-verdict/issues/57), P1/S: enforcement is wired (`require_issue_links: true`); issue existence, PR targets, repository restrictions, and exemptions need explicit decisions before finalizing.
6. [#94: Dependency and runtime compatibility](https://github.com/gordonpn/merge-verdict/issues/94) and [#93: Strict coverage gate rollout](https://github.com/gordonpn/merge-verdict/issues/93), P2/XS: minimum-Node bundle verification, Node 22.12 type declarations, and contributor toolchain alignment landed in PR #125. Hosted Action reporting, PR-origin compatibility, and branch-protection/Codecov baseline enforcement trials remain open.

## Parallel work and blockers

- Independent now: `#132`, `#126`, `#131` (unit/fixture scope; live payloads align with `#127`), `#128`, `#26`, and `#57` product decisions. Hosted dependency compatibility evidence remains coordinated through `#94` and `#78`.
- Credential-gated trials: `#73` live PASS, `#127`, and `#78` live runs require configured repository opt-in variables and `DEEPSEEK_API_KEY` without exposing secrets to fork code.
- After `#73`: `#74` automatic refresh needs race, ownership, cancellation, and fork evidence; `#75` additionally needs a maintainer-selected target repository and remote Action distribution.
- [#93](https://github.com/gordonpn/merge-verdict/issues/93) and [#76](https://github.com/gordonpn/merge-verdict/issues/76): hosted enforcement trials and branch-protection changes require explicit rollout gates; passing local coverage is insufficient.
- [#13](https://github.com/gordonpn/merge-verdict/issues/13) and [#14](https://github.com/gordonpn/merge-verdict/issues/14) retain distribution and approval lifecycle scope; the first advisory run does not complete those issues.

## LATER

See the [advisory rollout epic](https://github.com/gordonpn/merge-verdict/issues/71) and [open GitHub backlog](https://github.com/gordonpn/merge-verdict/issues?q=is%3Aissue+is%3Aopen) for deferred App identity (`#4`), configurable approvals (`#36`), webhook relay (`#5`, `#29`, `#30`), semantic LLM escalation (`#6`, `#31`), and evidence specification (`#38`, `#39`) work. Recorded reactivation conditions remain in force.
