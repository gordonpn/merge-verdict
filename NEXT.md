# Project Execution Queue

Last Refined: 2026-10-29T18:08:00-04:00
Repository: gordonpn/merge-verdict
GitHub Backlog: https://github.com/gordonpn/merge-verdict/issues

## NOW: Recommended Next Task

### [#8: feat(models): implement Zod domain schemas for reviewer findings and PR snapshots](https://github.com/gordonpn/merge-verdict/issues/8)

- **Priority:** P1
- **Estimate:** S
- **Readiness:** READY
- **Why this task is next:** Now that the project structure and TypeScript tooling are in place (#7), establishing strongly typed domain models is the foundational dependency required before implementing GitHub data collectors (#9), reviewer normalization adapters (#10), and the deterministic policy evaluator (#11).
- **First implementation action:** Install `zod` dependency (`pnpm add zod`) and implement schemas in `src/models/` for `Severity`, `ReviewerStatus`, `NormalizedFinding`, `ReviewerExecutionRecord`, `CheckRunRecord`, and `ReviewSnapshot`.
- **Definition of Done:** All Zod domain schemas validate compliant reviewer/PR payloads, reject malformed inputs with typed errors, compute deterministic state fingerprints, and pass 100% of unit tests in `tests/models/`.
- **Tasks it unblocks:** Unblocks [#9](https://github.com/gordonpn/merge-verdict/issues/9) (Collector) and [#10](https://github.com/gordonpn/merge-verdict/issues/10) (Normalizers); partially unblocks [#11](https://github.com/gordonpn/merge-verdict/issues/11) (which also requires #10).

## NEXT: Upcoming Work

1. **[#9: feat(collector): implement Octokit REST and GraphQL PR data collector](https://github.com/gordonpn/merge-verdict/issues/9)**
   - Priority: P1 | Estimate: M | Readiness: BLOCKED (by #8)
   - Dependencies: #8
   - Rationale: Implements batched queries to fetch PR review threads, comments, and check runs. Can be developed in parallel with #10 once domain models (#8) are in place.
2. **[#10: feat(normalizers): implement reviewer normalization adapters for CodeRabbit, Sourcery, Codex, and DeepSeek](https://github.com/gordonpn/merge-verdict/issues/10)**
   - Priority: P1 | Estimate: M | Readiness: BLOCKED (by #8)
   - Dependencies: #8
   - Rationale: Normalizes external reviewer artifacts, badges, and commit markers into uniform domain findings. Can be developed in parallel with #9.
3. **[#11: feat(policy): implement deterministic policy evaluator with 8 core verification rules](https://github.com/gordonpn/merge-verdict/issues/11)**
   - Priority: P1 | Estimate: M | Readiness: BLOCKED (by #8, #10)
   - Dependencies: #8, #10
   - Rationale: Core verification engine enforcing the policy decision matrix against normalized snapshots without LLM dependencies.
4. **[#12: test(fixtures): build offline replay test suite using SnapTally PR fixtures](https://github.com/gordonpn/merge-verdict/issues/12)**
   - Priority: P1 | Estimate: S | Readiness: BLOCKED (by #9, #10, #11)
   - Dependencies: #9, #10, #11
   - Rationale: Replays recorded real-world payloads from SnapTally PRs #119, #120, and #121 to verify end-to-end policy accuracy offline before Actions packaging.
5. **[#13: feat(action): implement reusable GitHub Action entry point with concurrency controls](https://github.com/gordonpn/merge-verdict/issues/13)**
   - Priority: P1 | Estimate: S | Readiness: BLOCKED (by #11)
   - Dependencies: #11
   - Rationale: Packages the core engine into an executable GitHub Action workflow step with input validation and loop guards.

## BLOCKERS

- None currently active for #8.
- Downstream tasks #9 through #14 remain sequentially blocked until their immediate dependencies are completed.

## LATER

- Milestone 2: GitHub Actions Integration ([#3](https://github.com/gordonpn/merge-verdict/issues/3), [#13](https://github.com/gordonpn/merge-verdict/issues/13), [#14](https://github.com/gordonpn/merge-verdict/issues/14))
- Milestone 3: GitHub App Identity and Checks API Publishing ([#4](https://github.com/gordonpn/merge-verdict/issues/4))
- Milestone 4: Webhook Relay for Thread-Resolution Events ([#5](https://github.com/gordonpn/merge-verdict/issues/5))
- Milestone 5: Optional Semantic LLM Escalation ([#6](https://github.com/gordonpn/merge-verdict/issues/6))
- Full backlog view: https://github.com/gordonpn/merge-verdict/issues
