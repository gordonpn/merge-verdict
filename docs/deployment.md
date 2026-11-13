# Merge Verdict MVP Deployment and Dogfooding Guide

## 1. Overview and MVP Objective

The Minimum Viable Product (MVP) for Merge Verdict establishes an automated, evidence-driven GitHub Action that runs in pull request workflows, reconciles multiple automated code reviewers alongside CI check runs, and publishes an authoritative status check named `merge-verdict` to gate branch protection.

The system requires zero external databases, zero persistent background servers, and zero mandatory third-party API keys. It operates entirely within GitHub Actions using repository workflow permissions.

```
+-----------------------------------------------------------------------------------+
|                            GitHub Pull Request Event                              |
|           (pull_request, pull_request_review, pull_request_review_comment)        |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                    Merge Verdict GitHub Action Runner                             |
|                                                                                   |
|  1. Collector (Octokit REST & GraphQL)                                            |
|     - Read PR metadata, reviews, threads, comments, CI checks, and statuses       |
|     - Read .github/merge-verdict.yml from protected base revision                 |
|                                                                                   |
|  2. Reviewer Normalizers                                                          |
|     - CodeRabbit: neutral checks, rate limits, inline comments                    |
|     - Sourcery: severity badges, addressed commits, thread resolutions           |
|     - Codex: summary JSON markers, evaluated commit SHA freshness                 |
|     - Copilot: reviews, verdicts, inline threads, freshness against head SHA      |
|     - Generic CI Checks: test, lint, and security scan conclusions                |
|                                                                                   |
|  3. Deterministic Policy Evaluator                                                |
|     - Evaluate 8 verification conditions                                          |
|     - Evaluate path-based risk tiers (strictest matching tier wins)               |
|     - Output structured verdict: PASS, PENDING, FAIL, STALE, or ERROR             |
|                                                                                   |
|  4. Publisher                                                                     |
|     - Publish authoritative merge-verdict check run or commit status              |
|     - Submit formal APPROVE review when eligible under configured provider        |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|               GitHub Branch Protection / Merge Queue Evaluation                   |
|                   (Required status check: merge-verdict)                          |
+-----------------------------------------------------------------------------------+
```

---

## 2. Component Readiness Matrix

| Component                         | Status   | Location                              | Notes                                                                                       |
| :-------------------------------- | :------- | :------------------------------------ | :------------------------------------------------------------------------------------------ |
| **Tooling & Task Runner**         | Complete | `Justfile`, `package.json`            | Strict TypeScript, Biome linter, Vitest test suite.                                         |
| **Domain Models**                 | Complete | `src/models/`                         | Schemas for findings, reviewer records, check runs, snapshots, state fingerprints.          |
| **PR Data Collector**             | Complete | `src/collector/`                      | Octokit REST and GraphQL pagination, protected base policy retrieval, error classification. |
| **Policy Configuration**          | Complete | `src/config/`, `src/models/config.ts` | Zod schema validating `.github/merge-verdict.yml` with strict typing and defaults.          |
| **Reviewer Normalizers**          | Pending  | `src/normalizers/`                    | Adapters for CodeRabbit, Sourcery, Codex, Copilot, and generic CI checks.                   |
| **Policy Evaluator**              | Pending  | `src/policy/`                         | 8-condition decision engine and path risk-tier resolver.                                    |
| **Action Entry Point & Bundling** | Pending  | `src/action/`, `dist/`                | Standalone bundler (`tsup`) generating `dist/index.js` for Action execution.                |
| **Status Publisher**              | Pending  | `src/publisher/`                      | Commit status and Checks API publisher, plus approval provider abstraction.                 |
| **Dogfood Workflow**              | Pending  | `.github/workflows/merge-verdict.yml` | Workflow triggering Merge Verdict within this repository.                                   |

---

## 3. Four Steps to the Production MVP

Four focused implementation steps complete the functional loop from code ingestion to branch protection gating:

### Step 1: Reviewer Normalizers (`src/normalizers/`)

Transform heterogeneous reviewer outputs collected from GitHub into uniform `NormalizedFinding` and `ReviewerExecutionRecord` structures:

1. **`src/normalizers/coderabbit.ts`**:
   - Detect neutral check runs caused by rate limits and flag as `RATE_LIMITED`.
   - Parse inline review comments and map severity tags (`critical`, `major`, `minor`).
   - Track thread resolution status from GraphQL thread metadata.
2. **`src/normalizers/sourcery.ts`**:
   - Parse severity badges (`High`, `Medium`, `Low`) from comment markdown.
   - Detect `Addressed in [sha]` comment markers and match against commit history.
3. **`src/normalizers/codex.ts`**:
   - Extract JSON summary markers (`<!-- codex-review-state:v1 {...} -->`).
   - Compare `commit_sha` against `pull_request.head.sha` to mark non-head evaluations as `STALE`.
4. **`src/normalizers/copilot.ts`**:
   - Ingest reviews from `copilot-pull-request-reviewer[bot]`.
   - Verify that `review.commit_id` matches `pull_request.head.sha`.
   - Parse readiness assessments and inline thread comments.
5. **`src/normalizers/generic-checks.ts`**:
   - Ingest CI check runs (`runner / test`, `runner / biome`, `CodeQL`, `codecov`).
   - Map check conclusions to standard pass/fail assertions.

### Step 2: Deterministic Policy Evaluator (`src/policy/`)

Evaluate the normalized snapshot against repository policy using pure functions with zero network calls:

1. **`src/policy/risk-tier.ts`**:
   - Match changed pull request file paths against configured glob patterns in `approval.risk`.
   - Apply the strictest-matching-tier-wins rule (defaulting to strictest baseline tier on unmatched paths).
   - Resolve `canAutoApprove`, `requiresHumanReview`, and verification effort level (`lite`, `balanced`, `max`).
2. **`src/policy/evaluator.ts`**:
   - Evaluate the 8 core conditions:
     1. Required CI checks reported `success`.
     2. Required reviewers completed review.
     3. No unresolved blocking or high-severity review threads exist.
     4. No active `CHANGES_REQUESTED` review decision exists.
     5. All reviewer evaluations evaluated the current `pull_request.head.sha`.
     6. Snapshot state fingerprint remains identical.
     7. Zero runtime verification errors occurred.
     8. Custom repository constraints satisfied.
   - Output structured verdict:
     - `PASS`: All 8 conditions satisfied.
     - `PENDING`: Required check or reviewer in progress, or rate-limited.
     - `FAIL`: Unresolved blocking finding, active changes requested, or failed check.
     - `STALE`: Outdated commit evaluated or race condition detected.
     - `ERROR`: Collector failure or invalid configuration.

### Step 3: Publisher Layer (`src/publisher/`)

Publish verification outcomes back to GitHub:

1. **`src/publisher/commit-status.ts` / `src/publisher/checks-api.ts`**:
   - Publish authoritative status check named `merge-verdict` bound to `pull_request.head.sha`.
   - Map verdicts to standard GitHub states:
     - `PASS` -> `conclusion: success` / `state: success`
     - `PENDING` -> `status: in_progress, conclusion: null` / `state: pending`
     - `FAIL` -> `conclusion: failure` / `state: failure`
     - `STALE` -> `conclusion: action_required` / `state: error`
     - `ERROR` -> `conclusion: failure` / `state: error`
   - Include structured Markdown summary table detailing check conclusions, reviewer statuses, and unresolved findings.
2. **`src/publisher/providers/`**:
   - Implement `ApprovalProvider` abstraction:
     - `github_copilot`: Checks for active Copilot approval on `head_sha`.
     - `github_app`: Submits `APPROVE` review via GitHub App identity when eligible.
     - `none`: Withholds PR review submission, relying solely on the authoritative status check.

### Step 4: Standalone Action Packaging (`action.yml` and Bundler)

Package the TypeScript engine into a self-contained GitHub Action:

1. **Action Manifest (`action.yml`)**:

   ```yaml
   name: "Merge Verdict"
   description: "Automated, evidence-based pull request verification and approval engine"
   author: "Gordon Pham-Nguyen"
   inputs:
     github-token:
       description: "GitHub token for API access"
       required: true
       default: "${{ github.token }}"
     config-path:
       description: "Path to repository verification policy file"
       required: false
       default: ".github/merge-verdict.yml"
   outputs:
     verdict:
       description: "Terminal verdict (PASS, PENDING, FAIL, STALE, ERROR)"
     summary:
       description: "Markdown evaluation summary"
   runs:
     using: "node22"
     main: "dist/index.js"
   ```
2. **Bundler Configuration (`tsup`)**:
   - Add `tsup` dev dependency to bundle `src/action/index.ts` and inlined GraphQL queries into a single standalone file: `dist/index.js`.
   - Add build recipe to `Justfile`: `just build`.
   - Check in or publish `dist/index.js` as part of the action distribution.

---

## 4. Dogfooding Guide (Running in this Repository)

Once the four MVP steps are in place, dogfooding Merge Verdict in `gordonpn/merge-verdict` requires three files:

### A. Repository Policy File (`.github/merge-verdict.yml`)

Commit this file to the default branch (`main`):

```yaml
required_checks:
  - "Analyze (javascript-typescript)"
  - "CodeQL"

required_reviewers:
  - coderabbitai
  - sourcery-ai

allow_advisory_exemptions: true
rate_limit_timeout_minutes: 30

verification:
  require_current_head_sha: true
  require_resolved_threads: true
  require_successful_ci: true
  require_code_evidence: true

approval:
  required_check: merge-verdict
  providers:
    - github_copilot
  require_verified_commit: true

  risk:
    low:
      paths:
        - "docs/**"
        - "**/*.md"
      automated_approval: allowed
      effort: lite

    high:
      paths:
        - ".github/workflows/**"
        - "src/**"
      automated_approval: additional_review
      require_human_review: true
      effort: max
```

### B. Action Workflow File (`.github/workflows/merge-verdict.yml`)

Commit this workflow to trigger the local Action on pull request activity, reviewer comments, and CI completion:

```yaml
name: merge-verdict

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review:
    types: [submitted, dismissed]
  pull_request_review_comment:
    types: [created, edited, deleted]
  issue_comment:
    types: [created, edited, deleted]
  check_run:
    types: [completed]
  workflow_run:
    workflows: ["CI", "CodeQL"]
    types: [completed]

concurrency:
  group: merge-verdict-${{ github.event.pull_request.number || github.event.workflow_run.pull_requests[0].number || github.event.check_run.pull_requests[0].number || github.sha }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
      statuses: write
    steps:
      - name: Checkout trusted verifier
        uses: actions/checkout@v4
        with:
          ref: ${{ github.base_ref || github.event.repository.default_branch }}
          path: .verifier

      - name: Run Merge Verdict
        uses: ./.verifier
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config-path: .github/merge-verdict.yml
```

### C. Branch Protection Configuration

Configure GitHub branch protection or repository ruleset on `main`:

1. Require status checks to pass before merging.
2. Add `merge-verdict` as a mandatory required status check.
3. Require branches to be up to date before merging.

---

## 5. Adoption Guide for External Repositories (e.g. SnapTally)

To adopt Merge Verdict in another repository such as `gordonpn/snaptally`:

### A. Configure Repository Permissions

Ensure GitHub Actions has the necessary permissions in repository settings (`Settings -> Actions -> General -> Workflow permissions`):

- Read and write permissions enabled, or explicit job permissions configured in the workflow.

### B. Add the Workflow (`.github/workflows/merge-verdict.yml`)

```yaml
name: merge-verdict

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review:
    types: [submitted, dismissed]
  pull_request_review_comment:
    types: [created, edited, deleted]
  issue_comment:
    types: [created, edited, deleted]
  check_run:
    types: [completed]
  workflow_run:
    workflows: ["CI", "Lint"]
    types: [completed]

concurrency:
  group: merge-verdict-${{ github.event.pull_request.number || github.event.workflow_run.pull_requests[0].number || github.event.check_run.pull_requests[0].number || github.sha }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write
      statuses: write
    steps:
      - name: Run Merge Verdict
        uses: gordonpn/merge-verdict@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### C. Privileged Execution Path for Fork Pull Requests

For fork contributions and Dependabot PRs under default GitHub security settings, `pull_request` workflows execute with a read-only token and cannot write check runs or submit PR reviews. To support external contributors safely:

- Follow the base-only `pull_request_target` pattern documented in `docs/security.md`.
- Never check out or execute code from the untrusted fork PR branch inside a privileged runner.
- The verifier executes purely against collected API payloads while checking out only the trusted base branch.

### D. Add Policy File (`.github/merge-verdict.yml`)

Configure the target repository's required reviewers and CI checks matching its tooling:

```yaml
required_checks:
  - "test"
  - "lint"
  - "typecheck"

required_reviewers:
  - coderabbitai
  - sourcery-ai
  - chatgpt-codex-connector

allow_advisory_exemptions: true
rate_limit_timeout_minutes: 30

approval:
  required_check: merge-verdict
  providers:
    - github_copilot
```

---

## 6. End-to-End Verification Scenarios

To confirm that the MVP is operating correctly:

1. **Passing PR Path**:
   - Create a pull request changing a documentation file.
   - Automated reviewers (CodeRabbit, Sourcery) review and report no blocking issues.
   - Required CI checks complete successfully.
   - Workflow executes and posts a green `merge-verdict` check run with conclusion `success`.
   - PR is unblocked for merge.
2. **Blocking Finding Path**:
   - Reviewer reports a `BLOCKER` or `HIGH` finding in an unresolved inline thread.
   - Workflow executes and posts `merge-verdict` with conclusion `failure`, listing the unresolved finding and file link in the summary table.
   - PR merge is blocked by branch protection.
3. **Stale Evaluation Path**:
   - A developer pushes a new commit to the pull request.
   - Reviewer evaluations on older commits are detected as stale (`isFresh: false`).
   - Workflow posts `merge-verdict` with status `in_progress` / state `pending`, withholding approval until reviewers re-evaluate the head commit.

---

## 7. Post-MVP Enhancements (Deferred Past Initial Deployment)

The following capabilities are deliberately excluded from the initial deployment:

1. **Edge Webhook Bridge (Cloudflare Worker)**:
   - Not required for standard workflows because resolving a thread is almost always accompanied by a new commit or an explanatory comment, which natively trigger GitHub Actions.
2. **Semantic LLM Escalation**:
   - Deterministic verification handles all definitive passes and failures without incurring external API token costs or prompt injection risks.
3. **Dedicated GitHub App Credentials**:
   - The reusable Action executes under workflow `GITHUB_TOKEN`, eliminating the operational overhead of generating and rotating private keys during initial adoption.
