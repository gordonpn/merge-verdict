# Implementation Decisions Log

This document records non-obvious engineering and implementation decisions made in Merge Verdict, ordered newest first. Major architectural decisions that are expensive to reverse are promoted to formal Architecture Decision Records under `docs/adr/`.

## 2026-11-10: Bounded API retries and rate-limit backoff in GitHub collector

- Decision: Implement bounded exponential backoff and rate-limit handling with strict pagination safety caps across all Octokit PR data collection calls.
- Rationale: Prevents unhandled crashes and API starvation during burst review activity while ensuring large PRs fail closed rather than exhausting runner memory.
- Rejected alternatives: Relying on default Octokit retries without explicit rate-limit backoff or max-page bounds.
- Source: [#34 Implement GitHub PR review state collector](https://github.com/gordonpn/merge-verdict/issues/34), [#46 Add bounded API retries and rate-limit backoff](https://github.com/gordonpn/merge-verdict/pull/46)

## 2026-11-09: Repository configuration schema with base-branch isolation

- Decision: Define repository configuration (`.github/merge-verdict.yml`) with Zod schemas and enforce loading configuration strictly from the target base branch revision rather than the PR head branch.
- Rationale: Untrusted PR head branches must never be permitted to weaken path risk tiers, alter reviewer rules, or disable required status check policies.
- Rejected alternatives: Reading `.github/merge-verdict.yml` from the PR head commit, allowing inline workflow overrides.
- Source: [#20 Define repository policy configuration schema](https://github.com/gordonpn/merge-verdict/issues/20), [#41 Define domain schema and loader for repository configuration](https://github.com/gordonpn/merge-verdict/pull/41)

## 2026-11-08: Authoritative status checks vs PR approvals

- Decision: Establish the required status check (`merge-verdict` check run via Checks API) as the authoritative merge gate, treating formal PR review approval as a secondary policy-gated convenience output.
- Rationale: Status checks are strictly bound to commit SHAs, are invalidated immediately upon new commits, and carry rich structured metadata, whereas PR approvals can persist across force pushes depending on repository settings.
- Rejected alternatives: Relying solely on formal PR approval as the merge gate, relying solely on legacy Commit Status API contexts without Checks API metadata.
- Source: [ADR 0002](adr/0002-authoritative-status-check-vs-pr-approval.md), [#32 Reconcile authoritative status check vs PR review approval](https://github.com/gordonpn/merge-verdict/issues/32), [#33 Establish authoritative status checks and memory authority rules](https://github.com/gordonpn/merge-verdict/pull/33)

## 2026-11-03: Pure TypeScript domain models with Zod validation

- Decision: Model reviewer findings, thread states, and PR snapshots using strict Zod schemas with immutable domain types decoupled from external runtime packages.
- Rationale: Decouples the core verdict policy engine from external provider payloads (CodeRabbit, DeepSeek, Sourcery, Copilot), allowing unit tests without network mocking.
- Rejected alternatives: Hand-rolled validation functions, raw untyped JSON parsing, coupling domain types directly to Octokit responses.
- Source: [#8 Define normalized review finding domain model](https://github.com/gordonpn/merge-verdict/issues/8), [#18 Implement Zod domain schemas for reviewer findings and PR snapshots](https://github.com/gordonpn/merge-verdict/pull/18)

## 2026-11-03: Actions-first hybrid architecture

- Decision: Adopt an Actions-first hybrid architecture executing a pure TypeScript library inside GitHub Actions with two-tier authentication (`GITHUB_TOKEN` and GitHub App token), deferring standalone webhook services until event latency requirements mandate them.
- Rationale: GitHub Actions provides zero-infrastructure operation, native secret management, and direct access to PR context with no ongoing cloud compute hosting costs.
- Rejected alternatives: Standalone 24/7 cloud service on Cloudflare Workers or AWS Lambda with persistent database and webhook queues.
- Source: [ADR 0001](adr/0001-actions-first-architecture.md), [#1 Define architecture for commit-scoped PR verification](https://github.com/gordonpn/merge-verdict/issues/1), [#16 Scaffold TypeScript project structure and task runner tooling](https://github.com/gordonpn/merge-verdict/pull/16)
