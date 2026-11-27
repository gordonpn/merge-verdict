# Project Execution Queue

Repository: [gordonpn/merge-verdict](https://github.com/gordonpn/merge-verdict)

Snapshot: 2026-11-27 UTC, base-policy source `origin/main` at `ddf9175f7bfbb794c10afd939266427439bd5edb`. GitHub Issues remain authoritative. The audit found 39 open issues and nine open PRs: [#154](https://github.com/gordonpn/merge-verdict/pull/154), [#176](https://github.com/gordonpn/merge-verdict/pull/176), [#177](https://github.com/gordonpn/merge-verdict/pull/177), [#178](https://github.com/gordonpn/merge-verdict/pull/178), [#179](https://github.com/gordonpn/merge-verdict/pull/179), [#180](https://github.com/gordonpn/merge-verdict/pull/180), [#181](https://github.com/gordonpn/merge-verdict/pull/181), [#182](https://github.com/gordonpn/merge-verdict/pull/182), and [#183](https://github.com/gordonpn/merge-verdict/pull/183). No PR is merged by this audit. This is a dated snapshot, not a claim that broader issue acceptance is complete.

## NOW

### Review [#178: Bind PR-Agent provenance to the current run attempt](https://github.com/gordonpn/merge-verdict/pull/178)

- Issue: [#173](https://github.com/gordonpn/merge-verdict/issues/173). Priority: P2. Effort: S. Readiness: reviewable implementation; human approval and merge remain outstanding.
- Reason: Prevents an earlier same-run attempt's artifact from authenticating a later attempt, strengthening the existing producer boundary without expanding rollout.
- First action: Review the required-attempt schema, artifact enumeration bounds, mismatch rejection, and the hosted attempt-2 receipt.
- Done: Human review accepts the bounded collector contract and the verified implementation is merged through this PR; keep issue lifecycle changes separate from review recommendations.
- Evidence: Head `3b7dda4` passes 948 local tests and standalone consumer smoke. Hosted run `45848904389` attempts 1 and 2 succeeded; attempt-2 artifact `15132382115` matches PR 178, the exact head, comment `7196294435`, and its raw body digest.
- Unblocks: More trustworthy producer validation in [#165](https://github.com/gordonpn/merge-verdict/issues/165). It does not complete upstream full-review state reconciliation.

## NEXT

1. [#176: Pin the PR-Agent runtime image](https://github.com/gordonpn/merge-verdict/pull/176), [#172](https://github.com/gordonpn/merge-verdict/issues/172), P2/S. Independent of #154/#178. Review immutable image identity, source/version evidence, and exact-head hosted publisher/artifact compatibility. Image identity is not proof of review correctness.
2. [#182: Add the Octokit ApprovalClient adapter](https://github.com/gordonpn/merge-verdict/pull/182), [#36](https://github.com/gordonpn/merge-verdict/issues/36), P2/M. Review the bounded adapter and pagination corrections independently. Action wiring, dismissal lifecycle, live approval recognition, and moving beyond provider `none` remain separate acceptance; this component does not authorize approval emission.
3. [#183: Resolve workflow-run PR identity](https://github.com/gordonpn/merge-verdict/pull/183), [#169](https://github.com/gordonpn/merge-verdict/issues/169), P3/S. Review the resolver and bounded pagination independently. Production wiring remains after #154: the Action does not yet invoke the resolver, and the workflow still rejects empty PR associations before execution.
4. [#179: Preserve multiline ranges and change metadata](https://github.com/gordonpn/merge-verdict/pull/179), [#26](https://github.com/gordonpn/merge-verdict/issues/26), P2/S. Review the explicit component slice. Previous-path rename provenance and literal 100 percent normalizer coverage remain open; keep the issue open.
5. [#181: Add the webhook relay Worker](https://github.com/gordonpn/merge-verdict/pull/181), [#5](https://github.com/gordonpn/merge-verdict/issues/5), P3. Review source/runtime contracts independently from deployment. Current-head refresh semantics, head-specific dispatch acceptance in [#30](https://github.com/gordonpn/merge-verdict/issues/30), deployed delivery/latency, secrets, and the existing relay reactivation decision remain explicit boundaries.

## BLOCKERS

- [#154](https://github.com/gordonpn/merge-verdict/pull/154), [#74](https://github.com/gordonpn/merge-verdict/issues/74), P2/M: ordinary quality checks pass, but the advisory policy verdict remains FAIL. The prior zero-job `action_required` hold was cleared by a supported rerun: [run 45849111083](https://github.com/gordonpn/merge-verdict/actions/runs/45849111083), attempt 2, executed its runner and succeeded. This clears that infrastructure hold only. Full live race, trusted-base fork, obsolete-publication, and recovery evidence remains with #74, [#73](https://github.com/gordonpn/merge-verdict/issues/73), and [#168](https://github.com/gordonpn/merge-verdict/issues/168). Cancellation remains disabled; no policy or check is weakened.
- [#180](https://github.com/gordonpn/merge-verdict/pull/180): the CodeQL dependency pins match upstream v4.39.4, but the current-head CodeQL check is neutral because three default-setup configurations are missing. Advanced `codeql.yml` is intentionally disabled while default setup is configured. A supported suite rerequest returned HTTP 404; [#186](https://github.com/gordonpn/merge-verdict/issues/186), P2/S, tracks the required analysis and supported recovery path. Do not enable competing CodeQL setups or treat neutral as success.
- Reviewer quotas remain service limitations, not completed reviews. Bounded retries and their outcomes belong in the PR audit. A successful reviewer workflow is not necessarily an affirmative review.
- No PR currently has a textual merge conflict against this main snapshot. Pairwise virtual merges also passed at audited heads, but those merges are not combined runtime proof. Recheck after every merge, especially shared reviewer documentation and #154/#183 wiring.
- [#75](https://github.com/gordonpn/merge-verdict/issues/75), P2/S, still needs a successful first manual trial, a maintainer-selected second repository, installation authorization, and reconciliation of its older Node 22 wording with the current Node 24 runtime. Do not assume a target or deploy automatically.

## Pending Closure Review

- [#150](https://github.com/gordonpn/merge-verdict/issues/150), [#155](https://github.com/gordonpn/merge-verdict/issues/155), and [#156](https://github.com/gordonpn/merge-verdict/issues/156) have merged contributions. Reconcile their complete acceptance evidence before recommending closure; this queue does not authorize closing them.
- [#148](https://github.com/gordonpn/merge-verdict/issues/148) and [#171](https://github.com/gordonpn/merge-verdict/issues/171) need scope reconciliation against merged normalizer/producer work and the still-open [#165](https://github.com/gordonpn/merge-verdict/issues/165) lifecycle evidence.

## LATER

- Concrete audit follow-ups: [#184](https://github.com/gordonpn/merge-verdict/issues/184), P3/S, bounds candidate archive downloads; [#185](https://github.com/gordonpn/merge-verdict/issues/185), P2/S, repairs the separate collector pagination boundary. Neither expands the current component PRs. [#187](https://github.com/gordonpn/merge-verdict/issues/187), P2/XS, tracks relay workflow-identifier dot-segment validation.
- [#76](https://github.com/gordonpn/merge-verdict/issues/76), P2/M: required-gate rollout remains a separate maintainer decision after #73/#74/#75 and live freshness/recovery evidence. No branch-protection or automatic-approval setting changes are implied.
- [#4](https://github.com/gordonpn/merge-verdict/issues/4): dedicated App identity/JWT work remains conditional on a demonstrated need beyond `GITHUB_TOKEN`.
- [#5](https://github.com/gordonpn/merge-verdict/issues/5), [#29](https://github.com/gordonpn/merge-verdict/issues/29), and [#30](https://github.com/gordonpn/merge-verdict/issues/30): source components may be reviewed now, but relay deployment remains conditional on observed thread-only refresh friction and explicit target/setup authorization.
- [#6](https://github.com/gordonpn/merge-verdict/issues/6), [#31](https://github.com/gordonpn/merge-verdict/issues/31), [#38](https://github.com/gordonpn/merge-verdict/issues/38), and [#39](https://github.com/gordonpn/merge-verdict/issues/39): semantic escalation and broader evidence/specification architecture retain their existing reactivation conditions.

See the [advisory rollout epic](https://github.com/gordonpn/merge-verdict/issues/71) and [open GitHub backlog](https://github.com/gordonpn/merge-verdict/issues?q=is%3Aissue+is%3Aopen).
