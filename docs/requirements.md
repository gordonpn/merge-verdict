# Merge Verdict Requirements Specification

## 1. Product Overview and Purpose

Merge Verdict is an automated, evidence-based pull request (PR) verification and approval engine.

In modern AI-assisted engineering workflows, coding agents (such as Codex CLI, OpenCode, and terminal-based assistants) draft pull requests, while multiple automated code reviewers (such as CodeRabbit, Sourcery, Codex review connectors, PR-Agent, DeepSeek Review, Biome, Actionlint, and CodeQL) inspect the changes. These reviewers produce overlapping, disparate, and sometimes conflicting feedback across GitHub comments, review threads, commit statuses, and check runs.

Engineers must manually check whether all automated reviewers have finished, reconcile multiple comment formats, confirm whether unresolved threads were addressed, verify that required CI tests passed, and decide whether the PR is ready to merge.

Merge Verdict automates this reconciliation. It continuously verifies PR review feedback against a defined verification policy and produces two concrete GitHub outputs:
1. A **GitHub required status check** (named `merge-verdict`) that gates merging via branch protection or repository rulesets.
2. An **actual GitHub PR review with `APPROVE`** when all policy conditions are satisfied.

### Fundamental Distinction

Merge Verdict is not a general-purpose AI code reviewer. It does not replace CodeRabbit, Sourcery, Codex, DeepSeek, or CodeQL. Instead, Merge Verdict is a meta-reviewer and verification orchestrator: it verifies the completion, freshness, and consistency of the existing review process without duplicating the underlying code analysis.

## 2. Project Scope and Boundaries

### In Scope

- Reconciling heterogeneous reviewer outputs into a normalized internal data model.
- Evaluating pull request review state against deterministic, configurable verification policies.
- Tracking GitHub review threads, inline comments, top-level review summaries, and review submission states (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`).
- Checking the completion status and conclusion of required CI checks, linters, and security analyzers.
- Detecting stale reviewer findings associated with older commits (commit SHA mismatch).
- Detecting incomplete, skipped, failed, or rate-limited reviewer runs.
- Publishing required status checks (`merge-verdict`) via the GitHub Commit Status API and GitHub Checks API.
- Submitting official GitHub `APPROVE` reviews when verification passes.
- Invalidating or updating previous verdicts when new review comments, thread updates, or commits arrive.
- Idempotent execution and concurrency controls to prevent event storms and self-triggering loops.
- Reusable configuration via repository-level configuration files (such as `.github/merge-verdict.yml`).
- Optional escalation to an OpenAI-compatible LLM endpoint (such as DeepSeek) solely for evaluating ambiguous or unresolved findings that cannot be resolved deterministically.

### Out of Scope (Non-Goals)

- **Automatic Merging**: Merge Verdict explicitly does not merge pull requests. Human engineers or dedicated merge bots remain responsible for executing the merge.
- **Direct Code Generation or Patching**: Merge Verdict evaluates review feedback; it does not write application code or automatically apply code fixes.
- **Mandatory LLM Dependency**: The initial MVP and core product must function with zero inference cost using deterministic GitHub metadata alone.
- **Replacement of External Reviewers**: Merge Verdict does not run its own static analysis, security scanning, or general code evaluation.

## 3. Functional Requirements

### FR-01: Automated Re-Evaluation on PR Lifecycle Events
The system must automatically evaluate or re-evaluate a pull request whenever relevant code or review state changes occur:
- Pull request opened, reopened, marked ready for review, or synchronized (new commit pushed).
- PR review submitted, edited, or dismissed.
- Inline PR review comment created, edited, or deleted.
- General PR conversation comment created or edited.
- Required CI workflow or check run completed.
- Review thread marked resolved or unresolved (via webhook bridge or comment dispatch).

### FR-02: Multi-Reviewer Feedback Ingestion
The system must query GitHub APIs to ingest feedback from all configured review tools, including external GitHub Apps (such as CodeRabbit), connected bot integrations (such as Sourcery, Codex connector, PR-Agent), workflow-based reviewers (such as DeepSeek Review, reviewdog), and status checks (such as CodeQL, Codecov, CI test suites).

### FR-03: Review Output Normalization
The system must normalize heterogeneous reviewer data into an internal, strongly typed schema that abstracts reviewer-specific idiosyncrasies into uniform entities: findings, summaries, execution signals, and check results.

### FR-04: Actionable vs Informational Classification
The system must differentiate actionable findings (such as defect reports, security warnings, missing tests, and contract violations) from purely informational comments (such as walkthrough summaries, high-level reviewer guides, change statistics, tip boxes, and conversational chatter).

### FR-05: Review Thread Resolution Tracking
The system must inspect every review thread on the pull request via the GitHub GraphQL API, verifying whether the thread is marked resolved (`isResolved: true`), which actor resolved it, and whether any unresolved comments remain.

### FR-06: Blocking Review Decision Detection
The system must identify any outstanding review decisions with state `CHANGES_REQUESTED`. A PR must not be approved while an active `CHANGES_REQUESTED` review from a required reviewer remains unaddressed and undismissed.

### FR-07: Required CI and Validation Status Verification
The system must verify that all required CI checks, test suites, linters, and security scanners have completed with a successful conclusion (`conclusion: "success"`) before approving.

### FR-08: Stale Reviewer Result Detection
The system must verify whether each reviewer's latest analysis corresponds to the current PR head commit SHA. If a reviewer evaluated an older commit and has not re-evaluated the latest commit, the system must flag the reviewer output as stale and enforce policy rules regarding stale evidence.

### FR-09: Incomplete, Skipped, and Rate-Limited Review Detection
The system must identify reviewer runs that did not perform a substantive review. Specifically, it must detect:
- Check runs with neutral or skipped conclusions resulting from rate limits (such as CodeRabbit free-tier hourly quotas).
- Workflow runs that failed or timed out.
- Reviewers that never ran or posted no completion signal.
The system must not treat missing, skipped, or neutral results as successful review completion by default.

### FR-10: Snapshot Freshness and Pre-Publication Verification
Before publishing a status check or submitting an approval review, the system must verify that the PR head SHA and review state have not changed during the execution window. If a race condition is detected (such as a new commit pushed or a new comment posted while the action was evaluating), the current evaluation must be discarded without publishing a success verdict.

### FR-11: Required Status Check Publication
The system must publish a status check named `merge-verdict` targeting the current PR head commit SHA. This check must support both:
- GitHub Commit Status API (`POST /repos/{owner}/{repo}/statuses/{sha}`) using `GITHUB_TOKEN`.
- GitHub Checks API (`POST /repos/{owner}/{repo}/check-runs`) when authenticated as a GitHub App.
The check must reflect the computed outcome (`pending`, `success`, `failure`, `error`).

### FR-12: Official GitHub PR Approval Submission
When all configured verification requirements are satisfied, the system must submit an official GitHub pull request review with event `APPROVE`. The review body must provide a concise, structured evidence summary detailing which checks passed, which reviewers completed, and why all threads are considered reconciled.

### FR-13: Policy-Driven Approval Withholding and Invalidation
The system must withhold approval whenever verification is incomplete, failing, stale, or ambiguous under configured rules. Furthermore, if a PR was previously approved by Merge Verdict and subsequent activity (such as a new commit or a reopened review thread) invalidates that approval:
- The `merge-verdict` status check must immediately transition to `pending` or `failure`.
- The existing approval must be dismissed or superseded according to configuration.

### FR-14: Loop Prevention and Self-Event Filtering
The system must detect and ignore events generated by its own bot identity or workflow runs (such as its own status check creations, comments, and review submissions) to prevent recursive event loops.

### FR-15: Reusable Multi-Repository Configuration
The system must load repository-specific policies from a tracked YAML configuration file (defaulting to `.github/merge-verdict.yml`). Sensible, secure defaults must apply when configuration options are omitted.

### FR-16: Optional Semantic Verification via LLM
The system must support an optional semantic verification module. When enabled, ambiguous or contested findings that cannot be resolved deterministically can be submitted to an OpenAI-compatible endpoint (such as DeepSeek) with strict token budgets, structured JSON schema outputs, and fail-closed defaults.

## 4. Verification Outcome States

Every evaluation must resolve to exactly one of the following five core outcome states:

| Internal State | Description | GitHub Commit Status | GitHub Check Run Conclusion | PR Approval Review Eligible |
|---|---|---|---|---|
| `PENDING` | Required checks or reviewers have not yet completed; evaluation is waiting for completion signals. | `pending` | `in_progress` (or omitted) | No |
| `PASS` | All configured verification conditions and policy rules are strictly satisfied for the current PR snapshot. | `success` | `success` | Yes (Submit `APPROVE`) |
| `FAIL` | One or more mandatory verification criteria are violated (e.g. failing CI, unresolved blocking thread, unaddressed `CHANGES_REQUESTED`). | `failure` | `failure` | No |
| `ERROR` | Verification could not complete reliably due to infrastructure failures, API rate limits, or network errors. | `error` | `action_required` / `timed_out` | No |
| `STALE` | The evaluation snapshot has been superseded by a newer commit or newer review activity. | `pending` | `neutral` / `cancelled` | No |

## 5. Non-Functional Requirements

### NFR-01: Execution Latency
- Deterministic policy evaluation must execute in under 15 seconds once runner resources are allocated.
- GitHub API queries must be batched using GraphQL where possible to minimize round-trip network latency.

### NFR-02: Deterministic Reproducibility
- Given identical inputs (GitHub API PR payload, review threads, check runs, and repository configuration), the deterministic policy engine must produce identical verdicts.
- All policy decisions must be traceable to explicit, verifiable rules.

### NFR-03: Zero Inference Cost by Default
- The system must function completely without calling external AI inference APIs unless semantic verification is explicitly enabled in configuration.

### NFR-04: Fail-Closed Resilience
- Any unexpected API failure, malformed payload, missing check, or unrecognized reviewer format must fail closed, resolving to `PENDING` or `ERROR` rather than defaulting to `PASS`.

### NFR-05: Least-Privilege Security Boundaries
- The engine must strictly enforce least-privilege token permissions (`pull-requests: write`, `statuses: write`, `checks: write`, `contents: read`).
- Workflows handling untrusted code from fork pull requests must execute inspection logic in unprivileged contexts. Privileged approval operations must never execute untrusted user code.

### NFR-06: Zero Data Retention and Privacy
- The core Actions-first architecture requires no external operational database. PR metadata and reviewer comments are processed in ephemeral runner memory and discarded upon workflow completion.

## 6. Success Criteria and Acceptance

1. **Deterministic Verification Gate**: Merge Verdict successfully prevents PR merges on protected branches when any required check fails, any thread is unresolved, or any required reviewer is missing.
2. **Native Approval Delivery**: Upon satisfaction of all policy criteria, Merge Verdict posts a green `merge-verdict` status check and a valid GitHub PR review with state `APPROVE`.
3. **Staleness Protection**: Pushing a new commit immediately transitions the `merge-verdict` check from `success` back to `pending`, preventing merges until all criteria are re-verified on the new commit SHA.
4. **Zero-Configuration Viability**: A repository can install Merge Verdict by referencing the standard GitHub Action in a workflow file, immediately obtaining baseline verification without custom server configuration.
