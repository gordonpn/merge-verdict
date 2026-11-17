# Project Execution Queue

Repository: [gordonpn/merge-verdict](https://github.com/gordonpn/merge-verdict)

Snapshot: 2026-11-16 UTC, main at `f7c536760d134cef7613ab505d367c5bbbaa0daf`. GitHub Issues remain authoritative. The scan found 26 open issues and three open implementation PRs. Later changes require a fresh query.

## NOW

### [#73: Complete the first manual advisory validation](https://github.com/gordonpn/merge-verdict/issues/73)

- Priority: P1. Effort: M. Readiness: in progress; clean PASS evidence awaits reviewer availability and review of the existing fixes.
- Reason: This is the remaining prerequisite for automatic advisory refresh and a second repository trial. ERROR, STALE, PENDING, and repeated publication have dated evidence in the issue.
- First action: Review PRs #120, #121, and #122, then repeat manual validation against the exact selected head once the fixes land and reviewers can complete.
- Done: Record clean PASS, invalid-input summary-only failure, repeat invocation, and sanitized regression evidence without enabling approvals or changing branch protection.
- Unblocks: [#74](https://github.com/gordonpn/merge-verdict/issues/74) and [#75](https://github.com/gordonpn/merge-verdict/issues/75).

## Existing independent PRs

| Issue                                                        | PR                                                         | Scope                             | Observed state                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| [#119](https://github.com/gordonpn/merge-verdict/issues/119) | [#120](https://github.com/gordonpn/merge-verdict/pull/120) | Optional reviewer workflow gating | Ready, mergeable, no unresolved inline threads; returned Actions runs pass |
| [#114](https://github.com/gordonpn/merge-verdict/issues/114) | [#121](https://github.com/gordonpn/merge-verdict/pull/121) | Copilot quota classification      | Ready, mergeable, no unresolved inline threads; returned Actions runs pass |
| [#118](https://github.com/gordonpn/merge-verdict/issues/118) | [#122](https://github.com/gordonpn/merge-verdict/pull/122) | DeepSeek check-run classification | Ready, mergeable, no inline threads; returned Actions runs pass            |

These branches target main independently. Workflow success does not prove a reviewer performed a review. Human review and merge remain required.

## NEXT

1. [#94: Runtime compatibility evidence](https://github.com/gordonpn/merge-verdict/issues/94), P2/XS: ready for bounded validation. Verify generated bundles at the declared runtime minimum separately from the newer contributor toolchain. Independent of the three existing PRs.
2. [#78: Optional reviewer origin validation](https://github.com/gordonpn/merge-verdict/issues/78), P2/S: origin matrix and cancellation documentation can proceed independently; live opt-in trials depend on credentials and default-branch workflow changes in #120.
3. [#26: Remaining normalizer boundary support](https://github.com/gordonpn/merge-verdict/issues/26), P2/S: define range coordinates, diff side, rename mapping, and fingerprint behavior before implementation. The full slice touches Copilot normalization and should follow #121.
4. [#57: Issue-link product decisions](https://github.com/gordonpn/merge-verdict/issues/57), P1/S: enforcement is wired; issue existence, PR targets, repository restrictions, and exemptions need explicit decisions. Decision work can proceed in parallel; do not invent defaults in code.

## Parallel work and blockers

- Independent now: review the existing PRs, validate #94 runtime compatibility, document the #78 origin matrix, and settle #26/#57 contracts.
- After #73: #74 automatic refresh needs race, ownership, cancellation, and fork evidence. #75 additionally needs the maintainer to identify a target repository and remote Action distribution.
- [#93](https://github.com/gordonpn/merge-verdict/issues/93) and [#76](https://github.com/gordonpn/merge-verdict/issues/76): hosted enforcement trials and branch-protection changes require their explicit rollout gates. Passing local coverage is insufficient.
- [#13](https://github.com/gordonpn/merge-verdict/issues/13) and [#14](https://github.com/gordonpn/merge-verdict/issues/14) retain distribution and approval lifecycle scope; the first advisory run does not complete those issues.

## LATER

See the [advisory rollout epic](https://github.com/gordonpn/merge-verdict/issues/71) and [open GitHub backlog](https://github.com/gordonpn/merge-verdict/issues?q=is%3Aissue+is%3Aopen) for deferred App identity, approvals, relay, semantic verification, and evidence specification work. Recorded reactivation conditions remain in force.
