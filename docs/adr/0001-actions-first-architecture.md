# ADR 0001: Actions-First Hybrid Architecture

## Status

Accepted

## Context

Merge Verdict is designed to verify that pull requests have satisfied all required review and validation criteria before merge. The system must fulfill two core functional outputs:

1. Publish a required GitHub status check (proposed name: `merge-verdict`) to block merging when verification criteria are not satisfied.
2. Submit an official GitHub PR review with state `APPROVE` when verification criteria are satisfied.

Two primary architectural archetypes were considered for implementing Merge Verdict:

1. **Standalone Hosted GitHub App Service**: A persistent, 24/7 cloud service (for example, deployed on Cloudflare Workers or AWS Lambda) backed by an event queue (such as Cloudflare Queues or SQS) and an operational database (such as Cloudflare D1 or PostgreSQL). The service receives GitHub webhooks directly, maintains PR review state in its own database, evaluates policies, and calls GitHub APIs to post check runs and reviews.
2. **Actions-First Hybrid Architecture**: A standalone TypeScript engine executed directly inside GitHub Actions workflows. The engine inspects live PR state via the GitHub REST and GraphQL APIs, computes a deterministic verification verdict, publishes a Checks API check run, and submits an `APPROVE` review. For authentication, it supports standard workflow tokens (`GITHUB_TOKEN`) for zero-infrastructure setups, and can be augmented with a GitHub App installation token (via `actions/create-github-app-token`) for organizations requiring independent bot identity and approval authority. An optional, lightweight webhook bridge (such as a serverless worker) is only introduced if specific events (such as `pull_request_review_thread` thread-resolution actions) cannot be triggered directly by native GitHub Actions workflow events.

## Decision

We adopt the **Actions-First Hybrid Architecture** as the foundational design for Merge Verdict.

The core verification logic will be implemented as a pure TypeScript library decoupled from GitHub Actions runtime wrappers. Execution will run within GitHub Actions workflows triggered by native GitHub pull request and review events.

Authentication and event delivery have separate responsibilities, subject to [ADR 0002](0002-authoritative-status-check-vs-pr-approval.md):
- **Workflow Token**: A trusted workflow can publish the authoritative check run when its `GITHUB_TOKEN` has effective `checks: write` permission. Restricted or fork-event tokens must not silently fall back to commit status publication. Approval emission follows the configured provider and its identity requirements.
- **Dedicated GitHub App Identity**: An installation access token minted from configured App credentials provides independent check ownership and the `github_app` approval identity. This changes authentication, not the publishing API or verdict rules.
- **Optional Serverless Webhook Bridge**: For repositories that require immediate re-evaluation upon review thread resolution (which GitHub does not dispatch to Actions workflows natively), an optional serverless worker forwards `pull_request_review_thread` webhooks to repository workflow dispatch events.

## Alternatives Evaluated

### Alternative A: Standalone 24/7 Hosted Service with Dedicated Database

- **Description**: Host a permanent web service that subscribes to repository webhooks, stores reviewer comments, thread states, and CI statuses in a transactional database, and manages state machines asynchronously.
- **Why Rejected**:
  - Requires maintaining operational infrastructure (DNS, compute, database migrations, backup, secrets, monitoring) for an open-source project that should be easily adoptable across individual repositories.
  - Introducing an internal database creates a split-brain synchronization risk against GitHub. GitHub is already the system of record for commit SHAs, review threads, and check runs. Caching review state in an external database risks serving stale verdicts if webhooks arrive out of order, are dropped, or fail to reconcile with force pushes.
  - Substantially increases operational cost and maintenance overhead before achieving product-market validation.

### Alternative B: Pure Actions-Only Without GitHub App or Webhook Bridge

- **Description**: Rely strictly on standard GitHub Actions triggers and default `GITHUB_TOKEN`.
- **Why Rejected as Sole Foundation**:
  - GitHub Actions does not natively support `on: pull_request_review_thread`. When a developer resolves a comment thread without adding a new comment or commit, an Actions-only workflow will not trigger.
  - Relying exclusively on `GITHUB_TOKEN` for PR approvals requires enabling the repository-level setting "Allow GitHub Actions to create and approve pull requests". In many enterprise and security-conscious environments, this setting is restricted by organization policy because any compromised workflow could approve arbitrary PRs.
  - Workflow tokens can be restricted by event, repository, or organization policy. A token without effective `checks: write` cannot publish the authoritative check; changing the API to legacy commit statuses is not a supported fallback.

## Trade-Offs

### Advantages

- **Zero Operational Infrastructure**: Users can adopt Merge Verdict by adding a single YAML workflow file to `.github/workflows/` without provisioning servers, databases, or third-party cloud accounts.
- **No Split-Brain State**: Verification is computed on demand from authoritative GitHub API snapshots (REST and GraphQL) at runtime.
- **Modular Portability**: Because the core engine is decoupled from the Action entry point, the same verification logic can later run inside a CLI, a pre-merge hook, or a persistent webhook daemon if requirements evolve.
- **Configurable Security Posture**: Repositories can use an authorized workflow token or a dedicated GitHub App installation token. Both publish the same required Checks API check run; the dedicated App adds independent identity.

### Disadvantages and Mitigations

- **Actions Queue Latency**: Running in GitHub Actions incurs container startup latency (typically 15 to 45 seconds).
  - _Mitigation_: Merge Verdict runs lightweight Node.js code with minimal dependencies, completing execution within seconds once the runner is allocated.
- **Missing Webhook Triggers**: Actions cannot trigger natively on `pull_request_review_thread` (thread resolution/unresolution).
  - _Mitigation_: Native triggers cover the vast majority of review lifecycle events (`pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `workflow_run`, `check_run`). An optional lightweight Cloudflare Worker webhook bridge is specified for environments requiring immediate zero-click thread resolution triggering.
- **Workflow Concurrency**: High-frequency review comments can trigger multiple concurrent Action runs.
  - _Mitigation_: Workflows will utilize GitHub Actions concurrency groups (`cancel-in-progress: true` keyed by PR number) combined with atomic snapshot validation against the PR head SHA and review fingerprint.

## Consequences

1. The project codebase will be structured as a modular TypeScript library with a thin GitHub Action entry point (`action.yml` and distribution bundle).
2. The verification engine must reconstruct all required state via GitHub API queries on every run rather than reading from a local database.
3. The project will provide first-class documentation and templates for both authorized `GITHUB_TOKEN` and dedicated GitHub App authentication modes, including required permissions and expected check source validation.

## Reconsideration Triggers

This decision should be reconsidered if:
- GitHub Actions runner latency becomes unacceptable for developers waiting on merge readiness.
- GitHub API rate limits (5,000 requests per hour per user/app) are systematically exceeded by frequent polling or re-evaluations on large PRs.
- GitHub deprecates workflow concurrency controls or introduces native support for all PR webhook events in Actions.
- Enterprise customers mandate a centralized multi-tenant control plane that cannot run inside repository Actions runners.
