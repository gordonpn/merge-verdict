# Merge Verdict

Merge Verdict is an automated, evidence-based pull request (PR) verification and approval engine for GitHub.

## Overview

Modern software development teams increasingly employ AI coding agents to author pull requests, followed by multiple automated code review tools (such as CodeRabbit, Sourcery, Codex review connectors, PR-Agent, DeepSeek Review, Biome, Actionlint, and CodeQL) to review changes.

These automated reviewers generate disparate, overlapping, and sometimes contradictory feedback across GitHub comments, review threads, and check runs. Engineering developers are left with the tedious task of manually tracking down reviewer outputs, verifying whether unresolved threads were addressed, checking that automated reviewers actually finished on the latest commit, and deciding whether the pull request is safe to merge.

Merge Verdict solves this reconciliation bottleneck. It acts as an automated verification orchestrator that monitors pull request activity, normalizes reviewer findings, verifies review completion and thread resolution against a defined policy, and publishes:

1. A **GitHub required status check** (named `merge-verdict`) to enforce branch protection.
2. An **official GitHub pull request review with `APPROVE`** when all policy requirements are met.

The developer remains responsible for executing the merge. Automatic merging is explicitly out of scope.

## What Merge Verdict Does and Does Not Do

### What It Does

- Evaluates PR review feedback against a configurable, deterministic verification policy.
- Reconciles heterogeneous review outputs from multiple tools into a unified data model.
- Verifies that all required CI tests, security analyzers, and linters completed with success.
- Detects unresolved review threads and outstanding `CHANGES_REQUESTED` decisions.
- Identifies stale reviewer findings that evaluate older commits rather than the PR head.
- Detects rate-limited, incomplete, or skipped reviewer runs.
- Enforces state freshness to prevent race conditions during review updates.
- Publishes status checks (`merge-verdict`) and submits official PR `APPROVE` reviews.

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
- **Runtime**: Runs directly in GitHub Actions runners using Node.js 22+.
- **No Database**: Reconstructs authoritative state on demand from live GitHub REST and GraphQL APIs, eliminating split-brain risks.
- **Flexible Identity**: Supports standard `GITHUB_TOKEN` credentials for zero-infrastructure setups, and seamlessly upgrades to dedicated GitHub App installation tokens for native Checks API integration and independent bot identity.
- **Decoupled Engine**: Core logic is implemented as a standalone TypeScript library, allowing it to run within GitHub Actions, a CLI, or an edge worker without modification.

For full architectural details, see [docs/architecture.md](file:///Users/gordonpn/workspace/merge-verdict/docs/architecture.md).

## Project Status

Merge Verdict is currently in the **foundation and architecture phase**. The architectural specifications, integration models, verification policies, and implementation roadmap have been established. Application implementation will proceed incrementally according to the milestone roadmap.

## Documentation Index

- [Requirements Specification](file:///Users/gordonpn/workspace/merge-verdict/docs/requirements.md): Functional and non-functional requirements, outcome states, and acceptance criteria.
- [Architecture Design](file:///Users/gordonpn/workspace/merge-verdict/docs/architecture.md): Subsystems, component responsibilities, data flow, and Mermaid diagrams.
- [Verification Policy](file:///Users/gordonpn/workspace/merge-verdict/docs/verification-policy.md): Verification conditions, severity handling, staleness rules, and decision matrix.
- [Reviewer Integrations](file:///Users/gordonpn/workspace/merge-verdict/docs/reviewer-integrations.md): Observed behavior from SnapTally reference PRs and normalized schemas.
- [Events and State](file:///Users/gordonpn/workspace/merge-verdict/docs/events-and-state.md): Event coverage, thread-resolution limitations, concurrency, and state transitions.
- [Security Architecture](file:///Users/gordonpn/workspace/merge-verdict/docs/security.md): Threat model, token permissions, fork isolation, and prompt injection defense.
- [Implementation Plan](file:///Users/gordonpn/workspace/merge-verdict/docs/implementation-plan.md): Five-milestone roadmap with explicit tasks and acceptance criteria.
- [Testing Strategy](file:///Users/gordonpn/workspace/merge-verdict/docs/testing.md): Unit tests, reference PR replay fixtures, and simulated edge-case testing.
- [ADR 0001: Actions-First Architecture](file:///Users/gordonpn/workspace/merge-verdict/docs/adr/0001-actions-first-architecture.md): Architectural decision record evaluating standalone service vs Actions-first design.
