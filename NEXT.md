# Project Execution Queue

Last Refined: 2026-10-29T12:11:00-04:00
Repository: gordonpn/merge-verdict
GitHub Backlog: https://github.com/gordonpn/merge-verdict/issues

## EXPERIMENT FIRST: gh-aw vertical slice

Before starting the bespoke TypeScript scaffold in issue #7, compile and test the [GitHub Agentic Workflows prototype](docs/prototypes/gh-aw.md). The prototype branch contains a Markdown workflow source that is deliberately **not installed, compiled, or activated**. Test against a disposable PR with actual review findings, required CI, and deliberate SHA drift. Keep the required `merge-verdict` check disabled on protected production branches until automated invalidation, reviewer-completion enforcement, and stale-review races are addressed.

**Decision checkpoint:** Keep `gh-aw` if its existing sandbox and safe-output model achieve acceptable fidelity, latency, and cost; implement custom orchestration only for demonstrated gaps. Existing backlog remains an alternative path, not an immediate commitment.

## NOW: Recommended Next Task

### [#7: feat(core): scaffold TypeScript project structure and task runner tooling](https://github.com/gordonpn/merge-verdict/issues/7)

- **Priority:** P1
- **Estimate:** XS
- **Readiness:** READY
- **Why this task is next:** This task establishes the baseline Node.js 22, TypeScript, pnpm lockfile, Biome linter, and Vitest test runner. It has zero prerequisites and is the foundational dependency required before implementing domain models, collectors, or policy rules.
- **First implementation action:** Initialize `package.json` with dependencies (`@actions/core`, `@octokit/rest`, `@octokit/graphql`, `zod`, `vitest`, `@biomejs/biome`), configure strict `tsconfig.json` targeting ES2022, and add recipes to `Justfile`.
- **Definition of Done:** `pnpm install` succeeds with frozen lockfile, `just typecheck` passes with zero errors, `just lint` reports no issues, and `just test` executes Vitest with zero failures.
- **Tasks it unblocks:** Unblocks [#8](https://github.com/gordonpn/merge-verdict/issues/8) (Zod domain schemas) and all subsequent Milestone 1 implementation stories.

## NEXT: Upcoming Work

1. **[#8: feat(models): implement Zod domain schemas for reviewer findings and PR snapshots](https://github.com/gordonpn/merge-verdict/issues/8)**
   - Priority: P1 | Estimate: S | Readiness: BLOCKED (by #7)
   - Dependencies: #7
   - Rationale: Establishes the uniform data contracts (NormalizedFinding, ReviewerExecutionRecord, ReviewSnapshot) required across collectors, normalizers, and the policy evaluator.
2. **[#9: feat(collector): implement Octokit REST and GraphQL PR data collector](https://github.com/gordonpn/merge-verdict/issues/9)**
   - Priority: P1 | Estimate: M | Readiness: BLOCKED (by #8)
   - Dependencies: #8
   - Rationale: Implements batched queries to fetch PR review threads, comments, and check runs. Can be developed in parallel with #10 once domain models (#8) are in place.
3. **[#10: feat(normalizers): implement reviewer normalization adapters for CodeRabbit, Sourcery, Codex, and DeepSeek](https://github.com/gordonpn/merge-verdict/issues/10)**
   - Priority: P1 | Estimate: M | Readiness: BLOCKED (by #8)
   - Dependencies: #8
   - Rationale: Normalizes external reviewer artifacts, badges, and commit markers into uniform domain findings. Can be developed in parallel with #9.
4. **[#11: feat(policy): implement deterministic policy evaluator with 8 core verification rules](https://github.com/gordonpn/merge-verdict/issues/11)**
   - Priority: P1 | Estimate: M | Readiness: BLOCKED (by #8, #10)
   - Dependencies: #8, #10
   - Rationale: Core verification engine enforcing the policy decision matrix against normalized snapshots without LLM dependencies.
5. **[#12: test(fixtures): build offline replay test suite using SnapTally PR fixtures](https://github.com/gordonpn/merge-verdict/issues/12)**
   - Priority: P1 | Estimate: S | Readiness: BLOCKED (by #9, #10, #11)
   - Dependencies: #9, #10, #11
   - Rationale: Replays recorded real-world payloads from SnapTally PRs #119, #120, and #121 to verify end-to-end policy accuracy offline before Actions packaging.

## BLOCKERS

- None currently active for #7.
- Downstream tasks #8 through #14 are sequentially blocked until their immediate dependencies are completed.

## LATER

- Milestone 2: GitHub Actions Integration ([#3](https://github.com/gordonpn/merge-verdict/issues/3), [#13](https://github.com/gordonpn/merge-verdict/issues/13), [#14](https://github.com/gordonpn/merge-verdict/issues/14))
- Milestone 3: GitHub App Identity and Checks API Publishing ([#4](https://github.com/gordonpn/merge-verdict/issues/4))
- Milestone 4: Webhook Relay for Thread-Resolution Events ([#5](https://github.com/gordonpn/merge-verdict/issues/5))
- Milestone 5: Optional Semantic LLM Escalation ([#6](https://github.com/gordonpn/merge-verdict/issues/6))
- Full backlog view: https://github.com/gordonpn/merge-verdict/issues
