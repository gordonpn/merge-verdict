# Project Execution Queue

Repository: [gordonpn/merge-verdict](https://github.com/gordonpn/merge-verdict)

Snapshot: 2026-11-22 UTC, main at `575d24b`. GitHub Issues remain authoritative. The scan found 29 open issues and one open PR, [#154](https://github.com/gordonpn/merge-verdict/pull/154). PRs #144, #149 and #153 are merged. This is a dated snapshot; later changes require a fresh query.

Delivery after that initial scan: [#161](https://github.com/gordonpn/merge-verdict/pull/161) implements #155, [#160](https://github.com/gordonpn/merge-verdict/pull/160) addresses #150, and [#158](https://github.com/gordonpn/merge-verdict/pull/158) addresses #156. They remain pending human review and merge; the issue list below is a subset of the backlog at the initial checkpoint.

## NOW

### [#165: PR-Agent producer attribution and reconciliation](https://github.com/gordonpn/merge-verdict/issues/165)

- Priority: P2. Effort: S. Readiness: implementation in [PR #167](https://github.com/gordonpn/merge-verdict/pull/167), awaiting hosted verification and human review.
- Reason: Selecting shared-bot comments after a review cannot identify the generated output of that run.
- First action: Investigate the hosted partial review's excluded-file coverage before attempting full state reconciliation. Exact posting-response binding is verified on `5229766`; the live state remains partial with older active findings.
- Done: Generated output binds to its own posting receipt; unrelated output and edits fail closed; same-head candidate ordering is verified; producer state and ticket-compliance behavior have live evidence.
- Unblocks: Authenticated PR-Agent evidence for [#73](https://github.com/gordonpn/merge-verdict/issues/73). Local tests alone do not complete the issue.
- Snapshot boundary: This NOW entry was refreshed on 2026-11-23 UTC. The surrounding backlog entries retain the older snapshot above and require live revalidation before execution. [#171](https://github.com/gordonpn/merge-verdict/issues/171) tracks the older attribution race and needs reconciliation against posting-response evidence, not automatic closure.

## NEXT

1. [#150: Clarify timeout fingerprint visibility](https://github.com/gordonpn/merge-verdict/issues/150), P2/XS, ready and in progress independently: verify time-dependent policy evaluation against unchanged evidence fingerprints, document refresh requirements, and correct the regex comment. Do not add speculative storage or timers.
2. [#156: Align Biome schema with the locked CLI](https://github.com/gordonpn/merge-verdict/issues/156), P3/XS, ready and in progress independently: remove the reproducible schema-version diagnostic without changing dependencies or lint rules.
3. [#73: Complete manual advisory validation](https://github.com/gordonpn/merge-verdict/issues/73), P1/M, remaining live evidence: FAIL reports are captured, but clean PASS, repeat owned-run updates, invalid-input behavior and sanitized evidence still need a coherent acceptance record. Do not treat successful runner jobs as a passing policy verdict.
4. [#148: PR-Agent format and producer-state hardening](https://github.com/gordonpn/merge-verdict/issues/148), priority and effort need bounded classification: first investigate persistent ACTIVE findings referring to removed code or superseded issue scope. Specify producer lifecycle and provenance before changing normalization; do not delete findings or weaken the merge gate.
5. [#151: Codex comment/fence ordering and malformed HTML contract](https://github.com/gordonpn/merge-verdict/issues/151), P3/XS, investigation ready: define canonical recovery behavior before implementing another parser change. Existing strict-stack recovery intentionally fails closed.

## Parallel work and blockers

- Independent implementation: #155, #150 and #156 use separate branches from this main revision and target main directly. No stacked PRs or shared implementation files are required.
- Independent investigation: #148 producer-state lifecycle, #151 parsing contract, and [#57](https://github.com/gordonpn/merge-verdict/issues/57) issue-link product decisions can proceed without widening those implementation PRs.
- [#154](https://github.com/gordonpn/merge-verdict/pull/154) covers bounded automatic trigger wiring for [#74](https://github.com/gordonpn/merge-verdict/issues/74). Hold rollout claims pending live race, fork-isolation, obsolete-publication and recovery evidence. Fork-review routing and thread-only refresh remain deferred; cancellation stays disabled.
- [#26](https://github.com/gordonpn/merge-verdict/issues/26) needs a range/rename metadata contract and explicit coverage verification. Its complete acceptance criteria are broader than adding a few boundary tests.
- [#127](https://github.com/gordonpn/merge-verdict/issues/127) and [#78](https://github.com/gordonpn/merge-verdict/issues/78) retain credential-backed origin and cancellation trials. Prior successful reviewer jobs do not complete the whole event matrix.
- [#75](https://github.com/gordonpn/merge-verdict/issues/75) requires a maintainer-selected target repository and reconciliation of its old Node 22 distribution requirement with the merged Node 24 baseline before installation work.
- [#94](https://github.com/gordonpn/merge-verdict/issues/94), [#93](https://github.com/gordonpn/merge-verdict/issues/93), and [#76](https://github.com/gordonpn/merge-verdict/issues/76) retain hosted compatibility, coverage-enforcement and production-gate acceptance. No branch-protection or approval rollout is implied by local tests.

## LATER

The pinned PR-Agent action wrapper still pulls a mutable runtime image tag. [#172](https://github.com/gordonpn/merge-verdict/issues/172) tracks pinning the runtime digest and verifying its source/version relationship independently from producer binding.

[#173](https://github.com/gordonpn/merge-verdict/issues/173) tracks binding provenance to the current workflow run attempt. Do not confuse same-head review discovery with verification of a same-run rerun's attempt.

The DeepSeek subsection implementation discovered existing fenced-heading and description-fidelity limits, tracked separately in [#162](https://github.com/gordonpn/merge-verdict/issues/162). Do not expand the observed-format fix to implement a general Markdown parser.

See the [advisory rollout epic](https://github.com/gordonpn/merge-verdict/issues/71) and [open GitHub backlog](https://github.com/gordonpn/merge-verdict/issues?q=is%3Aissue+is%3Aopen). App identity, webhook relay, configurable approvals, semantic escalation and evidence-specification work retain their existing reactivation conditions.
