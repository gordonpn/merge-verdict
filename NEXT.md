# Project Execution Queue

Last scanned: 2026-11-12. Default branch: `758195e`.
Repository: [gordonpn/merge-verdict](https://github.com/gordonpn/merge-verdict).

This is a dated planning snapshot, not merge authorization. The scan found 29 open issues and 18 open PRs. Open issues are not necessarily unstarted work. The collector, domain models, configuration loader, bounded API retries, and production dependency audit have already landed.

## Recommended next work

1. Resolve the existing foundation PRs, starting with [#53](https://github.com/gordonpn/merge-verdict/pull/53) (portable docs checks), [#49](https://github.com/gordonpn/merge-verdict/pull/49) (toolchain), and [#48](https://github.com/gordonpn/merge-verdict/pull/48) (CI workflows). Do not duplicate them. PR #48 has successful test, coverage, actionlint, Biome, and CodeQL runs, but currently reports merge conflicts. Most other PRs expose CodeQL and reviewer checks without remote unit-test/typecheck/docs results. PR #53 has unresolved reviewer concerns to triage before merge.
2. Review [#43](https://github.com/gordonpn/merge-verdict/pull/43) (normalizers) and its stacked boundary tests [#56](https://github.com/gordonpn/merge-verdict/pull/56), then [#58](https://github.com/gordonpn/merge-verdict/pull/58) (pure policy evaluator). PR #43 includes the Copilot adapter for issue #34 as well as issue #10. PR #56 targets the normalizer branch, not `main`.
3. Integrate collected data, normalized snapshots, trusted base policy, and the evaluator after their contracts are available. Extend [#61](https://github.com/gordonpn/merge-verdict/pull/61) from collector-only replay to end-to-end verdict assertions. This is the critical path toward a working Action.
4. Build the Action (#13) and authoritative publisher (#14) against the integrated engine. Reuse packaging [#44](https://github.com/gordonpn/merge-verdict/pull/44), risk tiers [#52](https://github.com/gordonpn/merge-verdict/pull/52), and bounded reports [#64](https://github.com/gordonpn/merge-verdict/pull/64). Provider strategies (#36) can be isolated earlier; publication and approval lifecycle integration still depend on these pieces.

## Existing work: do not start duplicates

| Open issue                        | Existing PR                                                                                                        | Remaining boundary                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| #10, #34 reviewer adapters        | [#43](https://github.com/gordonpn/merge-verdict/pull/43)                                                           | Review adapters and snapshot construction; #34 is already represented here.                                 |
| #11 deterministic evaluator       | [#58](https://github.com/gordonpn/merge-verdict/pull/58)                                                           | Pure evaluator; raw-data normalization, path policy, and publication are separate.                          |
| #12 offline replay                | [#61](https://github.com/gordonpn/merge-verdict/pull/61)                                                           | Recorded collector evidence; final normalization and verdict replay remain.                                 |
| #19, #47 CI workflows             | [#48](https://github.com/gordonpn/merge-verdict/pull/48)                                                           | Resolve merge conflicts and review workflow permissions, triggers, and required-gate coverage.              |
| #21 portable documentation checks | [#53](https://github.com/gordonpn/merge-verdict/pull/53)                                                           | Resolve actionable checker review feedback.                                                                 |
| #23 bounded pagination            | [#51](https://github.com/gordonpn/merge-verdict/pull/51)                                                           | Review fail-closed overflow behavior. Pagination already exists on main.                                    |
| #24 protected-base isolation      | [#50](https://github.com/gordonpn/merge-verdict/pull/50)                                                           | Fork identity and isolation regressions.                                                                    |
| #25 toolchain and Dependabot      | [#49](https://github.com/gordonpn/merge-verdict/pull/49)                                                           | Approved in the scanned review state; still requires maintainer merge.                                      |
| #26 normalizer boundaries         | [#56](https://github.com/gordonpn/merge-verdict/pull/56)                                                           | Stacked on #43; approved in the scanned review state.                                                       |
| #27 packaging                     | [#44](https://github.com/gordonpn/merge-verdict/pull/44)                                                           | Approved in the scanned review state; Action entry point still absent.                                      |
| #28 bounded check reports         | [#64](https://github.com/gordonpn/merge-verdict/pull/64)                                                           | Pure formatter; publication and live rendering remain. Triage missing finding-detail feedback.              |
| #29 webhook signatures            | [#62](https://github.com/gordonpn/merge-verdict/pull/62)                                                           | Signature primitive; authenticated relay deployment and handler integration remain.                         |
| #31 semantic verification         | [#63](https://github.com/gordonpn/merge-verdict/pull/63)                                                           | Injected advisory verifier; live provider and engine integration remain.                                    |
| #35 path risk tiers               | [#52](https://github.com/gordonpn/merge-verdict/pull/52)                                                           | Pure risk resolution; trusted-policy and approval wiring remain.                                            |
| #38 specification reconciliation  | [#54](https://github.com/gordonpn/merge-verdict/pull/54), [#60](https://github.com/gordonpn/merge-verdict/pull/60) | Publishing contract and evidence inventory are distinct slices. Review #60 relative-link feedback.          |
| #57 required issue link           | [#59](https://github.com/gordonpn/merge-verdict/pull/59)                                                           | Syntax parser; escaped-backtick feedback, evaluator wiring, and issue-existence/exemption decisions remain. |
| Deployment guidance               | [#42](https://github.com/gordonpn/merge-verdict/pull/42)                                                           | Reconcile with authoritative Checks API contract before relying on examples.                                |

CodeRabbit `NEUTRAL` and Sourcery `SKIPPED` results are not affirmative review evidence. A GitHub approval or passing CodeQL check alone does not establish every acceptance criterion. Recheck current threads, checks, and head revisions before merging. In particular, investigate #58 feedback about cancelled checks and unresolved-thread identity coverage before using its evaluator as an authoritative gate.

## Unblocked implementation lanes

These slices can each target `main` without importing another pending implementation. They do not complete their parent epics by themselves.

| Lane                                | Work                                                                                    | Contract and limit                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge reliability (#30)            | Test an injected per-PR debounce and dispatch primitive.                                | Coalesce bursts independently by repository and PR; carry newest head SHA. A process-local cache does not guarantee cross-isolate or durable delivery.                  |
| Approval strategies (#36)           | Test injected `github_app`, `github_copilot`, and `none` strategies.                    | Require PASS, path eligibility, and current SHA. Do not invent a Copilot API or claim branch-protection recognition. Full publisher integration remains blocked on #14. |
| Evidence review specification (#39) | Define provenance, independence, refusal examples, and mandatory human-review triggers. | Complement #60; do not claim the proposed evidence contract is an executable gate.                                                                                      |
| Backlog maintenance (#1, #2)        | Align this queue with actual merged and pending work.                                   | Refresh after merges instead of marking issues done when only a slice exists.                                                                                           |

The first three lanes are being prepared independently during this scan. Check current PRs before starting them again. Existing review fixes in #53, #58, #59, #60, and #64 are also parallelizable by branch; changes to pending implementations should target their feature branches or be incorporated by their owners.

## Parallel integration after prerequisites land

| Work                          | Required contracts                                                                      | Can run alongside                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| End-to-end replay (#12)       | Collector, #43 normalizers, #58 evaluator                                               | Action wrapper and publisher after engine interfaces settle.                |
| Reusable Action (#13)         | Integrated evaluator and collector, #44 packaging                                       | Publisher implementation through an agreed injected boundary.               |
| Authoritative publisher (#14) | #58 verdict contract, #64 reports, trusted policy, current-snapshot and identity checks | Action wrapper; provider-strategy unit tests can precede integration.       |
| Approval lifecycle (#36)      | #14, #52 path eligibility, authoritative fresh evidence                                 | Authenticated bridge deployment after Action dispatch inputs settle.        |
| Thread-event bridge (#5)      | #62 signature validation, #30 debounce, working dispatchable Action                     | Publisher and evidence-review work.                                         |
| Issue-link enforcement (#57)  | #59 parser, evaluator repository-rule hook, protected-base policy                       | End-to-end replay. Resolve issue-existence and exemption policy explicitly. |
| Semantic provider (#6)        | #63 verifier, trusted provider contract and explicit policy                             | Bridge deployment; semantic results remain advisory under current policy.   |

Do not merge all branches blindly. Collector changes (#50 and #51), normalizer boundary tests (#43 and #56), and documentation changes (#42, #54, #60) need combination checks. Approval lifecycle and check publication share security-sensitive state and require a coordinated integration contract.

## Completion evidence

Run `just format`, `just lint`, `just check-docs`, `just typecheck`, and `just test` before each implementation commit. Record actual results and unresolved integration limits in the PR. Full-system claims additionally need combined replay, current-head freshness tests, authoritative check lifecycle tests, and live identity/branch-protection validation where applicable.
