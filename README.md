# Merge Verdict

Merge Verdict is an automated, evidence-based pull request (PR) verification and approval engine for GitHub.

## Overview

Modern software development teams increasingly employ AI coding agents to author pull requests, followed by multiple automated code review tools (such as GitHub Copilot, CodeRabbit, Sourcery, Codex review connectors, PR-Agent, DeepSeek Review, Biome, Actionlint, and CodeQL) to review changes.

These automated reviewers generate disparate, overlapping, and sometimes contradictory feedback across GitHub comments, review threads, and check runs. Engineering developers are left with the tedious task of manually tracking down reviewer outputs, verifying whether unresolved threads were addressed, checking that automated reviewers actually finished on the latest commit, and deciding whether the pull request is safe to merge.

Merge Verdict solves this reconciliation bottleneck. It acts as an automated verification orchestrator that monitors pull request activity, normalizes reviewer findings, verifies review completion and thread resolution against a base-branch policy, and publishes two core outputs:

1. A **GitHub required status check** (named `merge-verdict`) to enforce branch protection as the authoritative automated merge gate.
2. An **official GitHub pull request review with `APPROVE`** via a configurable approval provider (`github_copilot` or `github_app`) when all policy and path risk-tier requirements are met.

The developer remains responsible for executing the merge. Automatic merging is explicitly out of scope.

An optional signed webhook relay handles thread-only resolution changes. Its
[deployment guide](docs/deployment.md#8-optional-webhook-relay-bridge-pull_request_review_thread)
defines the allowlist, fixed-window debounce, and delivery limits. Local tests do
not establish a deployed relay or a hosted delivery latency guarantee.

The standalone publisher exports `createOctokitApprovalClient` for authenticated
Octokit review operations and `publishPullRequestApproval` for provider dispatch.
Ownership attestation and deployment-specific capabilities remain caller supplied;
see the [approval provider contract](docs/approval-providers.md).

## What Merge Verdict Does and Does Not Do

### What It Does

- Evaluates PR review feedback against a configurable, deterministic verification policy loaded from the protected base branch.
- Enforces path-based risk tiers (strictest-matching-tier-wins) to tailor automated approval eligibility, human review requirements, and verification effort levels (`lite`, `balanced`, `max`).
- Reconciles heterogeneous review outputs from multiple tools into a unified data model.
- Verifies that all required CI tests, security analyzers, and linters completed with success.
- Detects unresolved review threads and outstanding `CHANGES_REQUESTED` decisions.
- Identifies stale reviewer findings that evaluate older commits rather than the PR head.
- Detects rate-limited, incomplete, or skipped reviewer runs.
- Enforces state freshness to prevent race conditions during review updates.
- Separates the verification verdict (`PASS`) from approval emission and branch-protection recognition across configurable approval providers (`github_copilot`, `github_app`, `none`).

### What It Does Not Do

- **Not a Code Reviewer**: It does not replace tools like CodeRabbit, Sourcery, or CodeQL; it verifies that those tools have completed and that their findings are addressed.
- **No Automatic Merging**: It does not merge pull requests automatically.
- **No Code Patching**: It does not write application code or automatically apply fixes to the PR branch.
- **No Mandatory LLM Dependency**: The core engine operates deterministically with zero AI inference costs.

## Deterministic Verification vs. Optional LLM Escalation

- **Deterministic Verification (Core)**: 100% of standard evaluations rely purely on structured GitHub metadata: commit SHAs, check run conclusions, review thread resolution states, review submission states, and comment markers.
- **Optional Semantic Verification (Escalation)**: Repositories can optionally configure an OpenAI-compatible endpoint (such as DeepSeek) to evaluate ambiguous, unacknowledged review findings against code diffs. This capability operates with strict token budgets and fail-closed defaults.

## Architecture

Merge Verdict adopts an **Actions-first hybrid architecture**:

- **Runtime**: The composite action invokes `node` from `PATH`. Callers must select Node.js `>=24.11.0` before invoking it; see the setup steps in [docs/deployment.md](docs/deployment.md).
- **No Database**: Reconstructs authoritative state on demand from live GitHub REST and GraphQL APIs, eliminating split-brain risks.
- **Flexible Identity**: Publishes the authoritative Checks API check run using credentials with effective `checks: write` permission. A dedicated GitHub App installation token provides an independent bot identity; credential choice never substitutes a legacy commit status for the required check run.
- **Decoupled Engine**: Core logic is implemented as a standalone TypeScript library, allowing it to run within GitHub Actions, a CLI, or an edge worker without modification.

For full architectural details, see [docs/architecture.md](docs/architecture.md).

PR-Agent provenance verification requires `actions: read` in the caller's workflow token. Upgrading from header-only attribution can leave PR-Agent `PENDING` until that permission is granted; see [docs/security.md](docs/security.md). The collector factory enables provenance collection by default. Direct `GitHubCollector` construction requires explicit opt-in, and the factory accepts `collectPrAgentProvenance: false` to disable collection. Disabling collection preserves legacy header-based attribution and does not provide authenticated workflow provenance.

The PR-Agent workflow publishes generated review text in a separate comment and records the comment ID and exact body digest from GitHub's posting response. Provenance schema version 2 requires a fresh `/review` run after upgrading; version 1 artifacts are rejected. The extra comment preserves upstream persistent finding state. Run `just test-pr-agent-producer` to verify the publisher and discovery regressions. See [reviewer integrations](docs/reviewer-integrations.md#25-pr-agent) for the trust boundary and failure behavior.

## Contributor Toolchain

The root `.node-version` pins Node.js 24.15.0. With fnm installed, enable
repository selection in Bash with `eval "$(fnm env --use-on-cd --shell bash)"`,
then run `fnm install` in the repository once to install its pinned runtime.
Subsequent directory changes select that version automatically.

The package runtime and contributor build both require Node.js `>=24.11.0`
(matching tsup 9's Node 24 requirement). GitHub's default Node runtime for
JavaScript actions does not select the runtime for this composite action.
Node type declarations stay on the `24.x` LTS line to prevent Node 25+ APIs from
entering source code, and CI builds with Node.js 24 then runs `just check-runtime`
on Node.js 24.11.0 to verify the generated standalone bundles at the package floor.

## Project Status

Merge Verdict is currently in the **foundation and architecture phase**. The architectural specifications, integration models, verification policies, and implementation roadmap have been established. Application implementation will proceed incrementally according to the milestone roadmap.

## Building

Run `pnpm install --frozen-lockfile`, then `just build` (or `pnpm run build`)
with Node.js `>=24.11.0` (24.15.0 is pinned). The build produces standalone `dist/index.js`
(ESM) and `dist/index.cjs` (CommonJS) bundles with source maps. Runtime
dependencies and GraphQL query text are included in each bundle; Node.js
built-ins are supplied by the runtime.

Run `pnpm run test:build` to rebuild and verify both distributions in a temporary
directory without `node_modules` or separate query files. The current entry
point exports the core library. GitHub Action event handling and `action.yml`
packaging are implemented separately. Generated `dist/` artifacts remain ignored.

## Documentation Index

The exported `resolveWorkflowRunPullRequestNumber` helper resolves one unambiguous
PR from direct references, fork head coordinates, or allowlisted comment-run
artifacts. REST lookups inspect up to 10 pages and 1000 items and return `null`
when pagination remains incomplete. The helper is not yet wired into the Action
event handler; [reviewer workflow validation](docs/reviewer-workflow-validation.md)
records the integration boundary.

- [Requirements Specification](docs/requirements.md): Functional and non-functional requirements, outcome states, and acceptance criteria.
- [Architecture Design](docs/architecture.md): Subsystems, component responsibilities, data flow, and Mermaid diagrams.
- [Verification Policy](docs/verification-policy.md): Verification conditions, severity handling, staleness rules, and decision matrix.
- [Reviewer Integrations](docs/reviewer-integrations.md): Observed behavior from SnapTally reference PRs and normalized schemas.
- [Events and State](docs/events-and-state.md): Event coverage, thread-resolution limitations, concurrency, and state transitions.
- [Commit-Scoped Approval Proposal](docs/commit-scoped-approval.md): Proposed lifecycle, evidence contract, invalidation behavior, and acceptance tests for issue #40.
- [Security Architecture](docs/security.md): Threat model, token permissions, fork isolation, and prompt injection defense.
- [Implementation Plan](docs/implementation-plan.md): Five-milestone roadmap with explicit tasks and acceptance criteria.
- [Testing Strategy](docs/testing.md): Unit tests, reference PR replay fixtures, and simulated edge-case testing.
- [ADR 0001: Actions-First Architecture](docs/adr/0001-actions-first-architecture.md): Architectural decision record evaluating standalone service vs Actions-first design.
- [ADR 0002: Authoritative Status Check vs PR Approval](docs/adr/0002-authoritative-status-check-vs-pr-approval.md): Architectural decision record establishing required status checks as the authoritative merge gate over formal PR approvals.
- [Agent Engineering Guidelines](AGENTS.md): Repository guidelines, memory authority rules, and project invariants for coding agents.
