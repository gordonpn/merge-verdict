# Project Execution Queue

Last Refined: 2026-10-30T18:23:00-04:00
Repository: gordonpn/merge-verdict
GitHub Backlog: https://github.com/gordonpn/merge-verdict/issues

## NOW: Recommended Next Task

### [#9: feat(collector): implement Octokit REST and GraphQL PR data collector](https://github.com/gordonpn/merge-verdict/issues/9)

- **Priority:** P1
- **Estimate:** M
- **Readiness:** READY
- **Why this task is next:** With strongly typed domain models in place (#8), the next step is fetching live PR data from GitHub APIs (review threads, comments, check runs) into uniform domain structures.
- **First implementation action:** Add `@octokit/rest` and `@octokit/graphql` (or native Octokit client) and implement query batching in `src/collector/`.
- **Definition of Done:** Collector queries GitHub REST and GraphQL endpoints for target PR, handles pagination up to 100 items per page, transforms raw API responses into raw collector models, and passes unit and integration tests with mocked Octokit fixtures.
- **Tasks it unblocks:** Unblocks [#11](https://github.com/gordonpn/merge-verdict/issues/11) (Policy Engine) and [#12](https://github.com/gordonpn/merge-verdict/issues/12) (Fixtures). Can proceed in parallel with [#10](https://github.com/gordonpn/merge-verdict/issues/10).

## NEXT: Upcoming Work

1. **[#10: feat(normalizers): implement reviewer normalization adapters for CodeRabbit, Sourcery, Codex, and DeepSeek](https://github.com/gordonpn/merge-verdict/issues/10)**
   - Priority: P1 | Estimate: M | Readiness: READY
   - Dependencies: #8
   - Rationale: Normalizes external reviewer artifacts, badges, and commit markers into uniform domain findings. Can be developed in parallel with #9.
2. **[#11: feat(policy): implement deterministic policy evaluator with 8 core verification rules](https://github.com/gordonpn/merge-verdict/issues/11)**
   - Priority: P1 | Estimate: M | Readiness: BLOCKED (by #9, #10)
   - Dependencies: #8, #9, #10
   - Rationale: Core verification engine enforcing the policy decision matrix against normalized snapshots without LLM dependencies.
3. **[#12: test(fixtures): build offline replay test suite using SnapTally PR fixtures](https://github.com/gordonpn/merge-verdict/issues/12)**
   - Priority: P1 | Estimate: S | Readiness: BLOCKED (by #9, #10, #11)
   - Dependencies: #9, #10, #11
   - Rationale: Replays recorded real-world payloads from SnapTally PRs #119, #120, and #121 to verify end-to-end policy accuracy offline before Actions packaging.
4. **[#13: feat(action): implement reusable GitHub Action entry point with concurrency controls](https://github.com/gordonpn/merge-verdict/issues/13)**
   - Priority: P1 | Estimate: S | Readiness: BLOCKED (by #11)
   - Dependencies: #11
   - Rationale: Packages the core engine into an executable GitHub Action workflow step with input validation and loop guards.

## COMPLETED

- [x] **[#7: feat(core): scaffold TypeScript project structure and task runner tooling](https://github.com/gordonpn/merge-verdict/issues/7)**
- [x] **[#8: feat(models): implement Zod domain schemas for reviewer findings and PR snapshots](https://github.com/gordonpn/merge-verdict/issues/8)**

## BLOCKERS

- Downstream tasks #11 through #14 remain sequentially blocked until their immediate dependencies are completed.

## LATER

- Milestone 2: GitHub Actions Integration ([#3](https://github.com/gordonpn/merge-verdict/issues/3), [#13](https://github.com/gordonpn/merge-verdict/issues/13), [#14](https://github.com/gordonpn/merge-verdict/issues/14))
- Milestone 3: GitHub App Identity and Checks API Publishing ([#4](https://github.com/gordonpn/merge-verdict/issues/4))
- Milestone 4: Webhook Relay for Thread-Resolution Events ([#5](https://github.com/gordonpn/merge-verdict/issues/5))
- Milestone 5: Optional Semantic LLM Escalation ([#6](https://github.com/gordonpn/merge-verdict/issues/6))
- Full backlog view: https://github.com/gordonpn/merge-verdict/issues
