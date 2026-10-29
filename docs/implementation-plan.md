# Merge Verdict Implementation Plan

## 1. Overview and Engineering Philosophy

This document outlines the phased, incremental implementation roadmap for Merge Verdict.

The plan prioritizes an **end-to-end vertical slice** first: constructing a working deterministic verification engine capable of evaluating real GitHub review data and publishing status checks, before adding GitHub App identity, edge webhook relays, or optional AI inference.

Every milestone defines concrete dependencies, individual tasks, acceptance criteria, and exact verification commands.

## 2. Milestone Overview

| Milestone | Name | Core Deliverable | Infrastructure Dependency |
|---|---|---|---|
| Milestone 1 | Deterministic Engine | Pure TypeScript policy engine, normalization adapters, and unit test suite | None (Local execution) |
| Milestone 2 | GitHub Actions Integration | Reusable Action publishing `merge-verdict` commit status and submitting PR approval | GitHub Actions (`GITHUB_TOKEN`) |
| Milestone 3 | GitHub App Integration | Dedicated bot identity, installation token authentication, and Checks API rich reports | GitHub App registration |
| Milestone 4 | Complete Event Coverage | Edge webhook bridge forwarding `pull_request_review_thread` events | Optional Cloudflare Worker |
| Milestone 5 | Optional Semantic Verification | OpenAI-compatible LLM escalation for ambiguous unresolved threads | OpenAI / DeepSeek API key |

## 3. Milestone 1: Deterministic Engine

### Objective
Implement the domain models, GitHub API data collection clients, reviewer normalizers, and deterministic policy engine as a pure, standalone TypeScript library.

### Dependencies
- Node.js 22+
- pnpm 10+
- Vitest
- Zod
- Octokit (`@octokit/rest`, `@octokit/graphql`)

### Tasks
1. **Scaffold Project**:
   - Initialize package with strict TypeScript settings (`tsconfig.json`), Biome linter, and Vitest test runner.
   - Configure project task runner (`Justfile`) with standard recipes (`test`, `lint`, `typecheck`, `build`).
2. **Implement Domain Models**:
   - Define and export Zod schemas in `src/models/` for `Severity`, `ReviewerStatus`, `NormalizedFinding`, `ReviewerExecutionRecord`, `CheckRunRecord`, and `ReviewSnapshot`.
3. **Implement GitHub Data Collector**:
   - Create `src/collector/github-collector.ts` using Octokit to execute batched GraphQL queries for PR review threads, reviews, check runs, and commit statuses.
4. **Implement Reviewer Normalization Adapters**:
   - `src/normalizers/coderabbit.ts`: Parse neutral check runs, rate-limit notices, and inline comments.
   - `src/normalizers/sourcery.ts`: Parse severity badges, `Addressed in [sha]` comment edits, and bot thread resolutions.
   - `src/normalizers/codex.ts`: Parse `codex-review-state:v1` JSON metadata and compare commit SHAs.
   - `src/normalizers/deepseek.ts`: Parse textual verdicts (`APPROVE`, `APPROVE WITH MINOR FINDINGS`, `REQUEST CHANGES`, `BLOCK`).
   - `src/normalizers/generic-checks.ts`: Normalize CI check runs (`runner / test`, `runner / biome`, `CodeQL`, `codecov`).
5. **Implement Deterministic Policy Engine**:
   - Create `src/policy/evaluator.ts` implementing the 8 mandatory verification conditions from the policy specification.
   - Output structured verdicts: `PASS`, `PENDING`, `FAIL`, `ERROR`, `STALE`.
6. **Create Comprehensive Unit Test Suite**:
   - Build fixture-driven unit tests in `tests/normalizers/` and `tests/policy/` using recorded payloads from SnapTally PRs #119, #120, and #121.

### Acceptance Criteria
- 100% of domain schemas validate valid payloads and reject malformed data.
- Normalizers correctly identify rate-limited CodeRabbit runs, stale Codex review commits, and Sourcery thread resolutions across SnapTally test fixtures.
- Policy evaluator produces deterministic verdicts with zero network calls in unit tests.

### Verification Commands
```bash
just typecheck
just lint
just test
```

## 4. Milestone 2: GitHub Actions Integration

### Objective
Package the engine into a reusable GitHub Action that executes in workflow runs, publishes the `merge-verdict` status check via the Commit Status API, and submits genuine PR approval reviews.

### Dependencies
- Milestone 1 completed
- `@actions/core`, `@actions/github`
- Build bundler (e.g. `ncc` or `esbuild`) to produce a standalone distribution bundle (`dist/index.js`)

### Tasks
1. **Implement Action Entry Point**:
   - Create `src/action/index.ts` to parse GitHub Actions workflow environment variables (`GITHUB_TOKEN`, `GITHUB_EVENT_PATH`).
2. **Define Action Metadata**:
   - Create `action.yml` declaring inputs (`github-token`, `config-path`, `fail-fast`) and outputs (`verdict`, `summary`).
3. **Implement Status Check Publisher**:
   - Create `src/publisher/commit-status.ts` calling `POST /repos/{owner}/{repo}/statuses/{sha}` with context `merge-verdict` and state `pending`, `success`, `failure`, or `error`.
4. **Implement PR Review Approval Submitter**:
   - Create `src/publisher/pr-review.ts` calling `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with event `APPROVE` and structured Markdown summary body.
5. **Implement Concurrency and Self-Trigger Guard**:
   - Add actor and bot check filters to ignore workflow self-events and prevent infinite loops.
6. **Provide Example Workflow Definition**:
   - Add `.github/workflows/merge-verdict.yml` demonstrating multi-event triggers with PR concurrency grouping.

### Acceptance Criteria
- Workflow executes successfully on `pull_request` and `pull_request_review` events.
- On a passing PR, the action posts a green `merge-verdict` status check on the current head commit and submits an `APPROVE` review under `github-actions[bot]`.
- Pushing a new commit immediately reverts the check to `pending` until re-evaluated.

### Verification Commands
```bash
just build
# Execute automated integration test against mock GitHub environment
pnpm vitest run tests/action/
```

## 5. Milestone 3: GitHub App Integration

### Objective
Enable Tier 2 authentication via a dedicated GitHub App identity (`merge-verdict[bot]`), supporting rich Markdown reports via the native Checks API and approval reviews without broad repository-level workflow permission overrides.

### Dependencies
- Milestone 2 completed
- Registered GitHub App with App ID and private key
- `actions/create-github-app-token` or internal JWT token generator

### Tasks
1. **Implement GitHub App Token Minting**:
   - Support reading GitHub App credentials (`app-id`, `private-key`) to generate installation access tokens at runtime.
2. **Implement Checks API Publisher**:
   - Create `src/publisher/checks-api.ts` calling `POST /repos/{owner}/{repo}/check-runs` to create rich check runs named `merge-verdict` featuring detailed Markdown tables, finding breakdowns, and duration metrics.
3. **Branch Protection Validation**:
   - Validate that check runs created by the GitHub App satisfy required status check branch protection rules.
4. **Integration Testing**:
   - Execute test cases verifying that the GitHub App can approve PRs authored by different users and fails cleanly when attempted on self-authored PRs.

### Acceptance Criteria
- Merge Verdict runs with a dedicated bot avatar and name (`merge-verdict[bot]`).
- Check run output includes structured Markdown summaries directly inside the GitHub PR Checks tab.
- Operates in repositories where "Allow GitHub Actions to create and approve pull requests" is disabled.

## 6. Milestone 4: Complete Event Coverage (Webhook Bridge)

### Objective
Bridge the GitHub Actions platform limitation regarding thread resolution (`pull_request_review_thread`) by deploying an optional lightweight serverless webhook relay.

### Dependencies
- Milestone 2 or 3 completed
- Cloudflare Workers or serverless edge platform
- GitHub App webhook subscription to `pull_request_review_thread`

### Tasks
1. **Implement Webhook Bridge Worker**:
   - Create `bridge/worker.ts` with HMAC SHA-256 signature verification for GitHub webhooks.
2. **Filter and Forward**:
   - Filter incoming events for `pull_request_review_thread` with actions `resolved` or `unresolved`.
   - Forward valid events to target repository via `POST /repos/{owner}/{repo}/actions/workflows/merge-verdict.yml/dispatches`.
3. **Debounce and Coalesce**:
   - Implement short edge debouncing (e.g. 5-second window) to collapse rapid consecutive thread resolutions into a single dispatch.

### Acceptance Criteria
- Clicking "Resolve conversation" on a GitHub PR thread without adding a comment triggers a verification workflow run within 10 seconds.
- Invalid webhook signatures are rejected with HTTP 401.

## 7. Milestone 5: Optional Semantic Verification

### Objective
Escalate ambiguous or unacknowledged review findings to an OpenAI-compatible model (such as DeepSeek) for semantic diff evaluation.

### Dependencies
- Milestone 1 completed
- OpenAI SDK or lightweight fetch wrapper
- Valid API key for DeepSeek or OpenAI-compatible provider

### Tasks
1. **Implement Semantic Adapter**:
   - Create `src/semantic/llm-verifier.ts` accepting finding context, developer comment, and git diff hunk.
2. **Enforce Delimited Prompting**:
   - Wrap untrusted inputs in XML tags and apply rigid system prompts to prevent instruction injection.
3. **Enforce Structured JSON Outputs**:
   - Require model output to conform to Zod schema: `{ resolution: "RESOLVED" | "UNRESOLVED" | "NOT_APPLICABLE" | "UNCERTAIN", explanation: string, confidence: number }`.
4. **Implement Budget and Cost Controls**:
   - Add configuration parameters for max tokens per run and max calls per PR.
   - Enforce fail-closed fallback: any timeout, schema violation, or `UNCERTAIN` response preserves the thread as unresolved.

### Acceptance Criteria
- Semantic verifier correctly distinguishes resolved versus unresolved findings across mock diff fixtures.
- Prompt injection attempts inside comments fail to alter the JSON verdict.
- Zero API calls are executed when semantic verification is disabled in configuration.

### Verification Commands
```bash
just test-semantic
```
