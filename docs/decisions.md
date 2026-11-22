# Implementation Decisions Log

This document records non-obvious engineering and implementation decisions made in Merge Verdict, ordered newest first. Major architectural decisions that are expensive to reverse are promoted to formal Architecture Decision Records under `docs/adr/`.

## 2026-11-22: Authenticate PR-Agent workflow attribution and harden producer configuration

- Decision: Emit a workflow-bound `pr-agent-review-provenance` artifact in `.github/workflows/pr-agent.yml` recording `workflow_path`, `run_id`, `repository`, `pull_request_number`, `head_sha`, `comment_id`, and `body_digest`; verify that workflow run and artifact in `GitHubCollector` (with `actions: read` in `.github/workflows/merge-verdict.yml`); require verified provenance in `normalizePrAgentReviewer` whenever `prAgentProvenance` is supplied; and configure `PR_REVIEWER.REQUIRE_TICKET_ANALYSIS_REVIEW: "false"`, `PR_REVIEWER.NUM_MAX_FINDINGS: "10"`, and `PR_REVIEWER.MAX_PREVIOUS_FINDINGS_CHARS: "0"` in `.github/workflows/pr-agent.yml`.
- Rationale: All workflows using `GITHUB_TOKEN` share the `github-actions[bot]` login, so comment identity and markers alone cannot distinguish `.github/workflows/pr-agent.yml` from another workflow in the same repository. GitHub Actions binds workflow runs and artifacts to the originating workflow file path without needing a PR head checkout. Disabling PR-Agent's upstream ticket analysis prevents partial-milestone `Refs #...` tracking epics from creating false blockers while Merge Verdict checks issue links via `verification.require_issue_links`, raising `NUM_MAX_FINDINGS` avoids the 3-finding partial-run lockup in upstream PR-Agent, and disabling previous-finding prompt injection prevents stale finding prose from being echoed verbatim after fixes while keeping deterministic `finding_id` reconciliation intact.
- Rejected alternatives: Disabling `PERSISTENT_FINDING_STATE` or filtering bot findings in `src/normalizers/pr-agent.ts` (weakens fail-closed guarantees), or using `publish_as_check_run: true` (disables structured state tracking in upstream `PRReviewer`).
- Verification: Collector, normalizer, and bounded stdlib ZIP extraction unit tests verify verified matching, tampered body rejection, `unverified`/`unavailable` fail-closed handling, and `runner / pr-agent` `appSlug` checks. Live workflow execution on PR #167 verified omitted ticket compliance and uploaded the `pr-agent-review-provenance` artifact.
- Trade-offs and failure modes: Renaming `.github/workflows/pr-agent.yml`, denying `actions: read`, missing artifacts, or later in-place edits of the comment body fail closed to `PENDING` without weakening finding capture. `createGitHubCollector` defaults `collectPrAgentProvenance` to `true`, whereas direct `GitHubCollector` callers default to `false`. Because upstream `pr-agent` posts via `GITHUB_TOKEN` without embedding a per-run cryptographic nonce, sibling workflows in the same repository that hold write permissions and race before `Record review provenance` remain outside single-workflow attribution guarantees unless PR-Agent runs under its own dedicated GitHub App.
- Origin: [Issue #165](https://github.com/gordonpn/merge-verdict/issues/165).

## 2026-11-22: Keep evidence fingerprints independent of timeout evaluation

- Decision: Preserve the evidence-only fingerprint and reevaluate time-dependent policy on each invocation using the snapshot's explicit collection time.
- Rationale: The Action already evaluates unconditionally. Equal evidence fingerprints can legitimately accompany different verdicts across a rate-limit timeout deadline.
- Rejected alternatives: Hashing collection time would invalidate evidence freshness on every collection. Adding storage or timers is unnecessary for this contract clarification; automatic refresh remains separate scheduling work.
- Verification: A regression computes real fingerprints before, at, and after the timeout, asserting identical fingerprints, exact verdicts and exemptions, and unchanged execution statuses.
- Origin: [Rate-limit timeout fingerprint contract](https://github.com/gordonpn/merge-verdict/issues/150).

## 2026-11-22: Preserve verdict severity while reading DeepSeek subsections

- Decision: Recognize numbered level-three material finding headings and keep each heading's supporting text together. Apply the adapter's existing verdict-derived severity and blocking rules.
- Rationale: Live reviewer output uses subsections where the collector previously returned no findings. Preserving the severity contract limits the change to recovering those findings and maintains existing policy behavior.
- Rejected alternatives: Inferring severity from arbitrary heading text would introduce a new interpretation contract beyond the observed parsing failure.
- Source: [DeepSeek subsection parsing](https://github.com/gordonpn/merge-verdict/issues/155).

## 2026-11-21: Standardize runtime and build baseline on Node.js 24 LTS

- Decision: Raise the package and build runtime baseline to Node.js 24 LTS (`>=24.11.0`, matching `tsup` 9's Node 24 floor), track `@types/node` on the `24.x` line while ignoring `>=25.0.0` in Dependabot, target `node24` in `tsup`, run CI/action workflows on Node.js 24, and run `just check-runtime` on `24.11.0` to verify standalone bundles at the declared floor. Supersedes the 2026-11-15 decision.
- Rationale: Aligning the package minimum with `tsup` 9 (`^24.11.0`) lets contributors build and test on the same Node 24 LTS line. GitHub's default Node runtime applies to JavaScript actions; this composite action invokes `node` from `PATH`, so callers must select Node.js `>=24.11.0` before invoking it. Allowing `24.x` type updates preserves type-definition fixes while blocking Node 25/26 APIs, and `check-runtime` on `24.11.0` verifies bundle compatibility at the floor.
- Trade-offs: Drops support for Node.js 22.x consumers, and `24.x` declarations can include minor APIs added after `24.11.0` until caught by `check-runtime` or tests.
- Rejected alternatives: Remaining pinned to Node 22.12.x (`@types/node <22.13.0`), or dropping `24.11.0` bundle verification in CI.
- Source: [#143](https://github.com/gordonpn/merge-verdict/issues/143), [#144](https://github.com/gordonpn/merge-verdict/pull/144).

## 2026-11-19: Require revision provenance for Codex quota classification

- Decision: Classify quota exhaustion only when the explicit Codex diagnostic shares a failed machine-readable state artifact bound to the current head SHA. Preserve blocking findings and stale-state precedence.
- Rationale: The observed quota-only conversation notice carries no commit identity. Pairing it with another artifact by timestamp can associate an older quota event with a genuine current execution error.
- Trade-offs: The observed separate notice continues to yield `FAILED` until the connector provides revision-bound evidence. The adapter accurately handles a combined diagnostic without inventing a completed review.
- Rejected alternatives: A time window joining independent summary and quota comments, or assuming all failed Codex runs after a quota notice are rate limited.
- Source: [Codex quota classification](https://github.com/gordonpn/merge-verdict/issues/126).

## 2026-11-15: Validate the minimum runtime separately from build tooling

- Decision: Keep the package runtime at Node.js 22.12.0, limit Node type declarations to the 22.12 series, and run existing standalone bundle checks on exactly 22.12.0 after CI builds with a supported contributor runtime.
- Rationale: The build tool requires a newer runtime; running it at the package minimum would test an unsupported toolchain rather than library compatibility. Matching declarations prevents newer Node APIs from silently entering source code.
- Trade-offs: Bundle smoke checks exercise exports and representative operations, not every possible runtime path or hosted GitHub behavior.
- Rejected alternatives: Raising the package runtime requirement to match tsup, or treating tests on the latest Node 22 release as evidence for 22.12.0.
- Source: [Runtime compatibility evidence](https://github.com/gordonpn/merge-verdict/issues/94).

## 2026-11-13: Bounded API retries, rate-limit backoff, and fail-closed pagination in GitHub collector

- Decision: Implement bounded exponential backoff, rate-limit handling, and fail-closed pagination safety caps (maximum 10 pages / 1000 items per collection at page size 100) across GraphQL and REST Octokit PR data collection calls.
- Rationale: Prevents unhandled crashes and API starvation during burst review activity while ensuring large PRs fail closed rather than exhausting runner memory.
- Rejected alternatives: Relying on default Octokit retries without explicit rate-limit backoff or max-page bounds.
- Source: [#34 Implement GitHub PR review state collector](https://github.com/gordonpn/merge-verdict/issues/34), [#46 Add bounded API retries and rate-limit backoff](https://github.com/gordonpn/merge-verdict/pull/46), [#51 Fail closed when pagination exceeds safety bounds](https://github.com/gordonpn/merge-verdict/pull/51)

## 2026-11-09: Repository configuration schema with base-branch isolation

- Decision: Define repository configuration (`.github/merge-verdict.yml`) with Zod schemas and enforce loading configuration strictly from the target base branch revision rather than the PR head branch.
- Rationale: Untrusted PR head branches must never be permitted to weaken path risk tiers, alter reviewer rules, or disable required status check policies.
- Rejected alternatives: Reading `.github/merge-verdict.yml` from the PR head commit, allowing inline workflow overrides.
- Source: [#20 Define repository policy configuration schema](https://github.com/gordonpn/merge-verdict/issues/20), [#41 Define domain schema and loader for repository configuration](https://github.com/gordonpn/merge-verdict/pull/41)

## 2026-11-08: Authoritative status checks vs PR approvals

- Decision: Establish the required status check (`merge-verdict` check run via Checks API) as the primary authoritative merge gate, and require a formal PR review with state `APPROVE` as a mandatory second output when eligible under the matched path risk tier.
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
