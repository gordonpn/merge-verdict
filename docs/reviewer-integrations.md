# Reviewer Integrations Specification

## 1. Overview and Integration Landscape

Merge Verdict reconciles feedback from a wide array of automated pull request review tools. Rather than attempting to re-analyze code diffs directly, Merge Verdict consumes the structured data, inline comments, top-level reviews, and check runs emitted by these tools.

This document details:
1. Concrete behaviors observed across real-world pull requests in the reference repository [gordonpn/snaptally](https://github.com/gordonpn/snaptally) (specifically PRs #119, #120, and #121).
2. The normalized internal schema used to represent findings and reviewer states.
3. Specific parsing and reconciliation rules for each reviewer integration.
4. Clear distinctions between verified platform behaviors and working assumptions requiring validation.

## 2. Reference Integrations (Observed from SnapTally)

### 2.1. CodeRabbit

- **Identity**: External GitHub App (`coderabbitai`, `coderabbitai[bot]`).
- **Artifacts Emitted**:
  - Pull request review summaries (issue comments) containing walkthroughs, change stack links, and file tables.
  - Inline review comments on modified code lines.
  - Check runs named `CodeRabbit` with conclusions `SUCCESS`, `NEUTRAL`, or `FAILURE`.
- **Observed Behavior on Reference PRs**:
  - In PR #119, #120, and #121, the `CodeRabbit` check run returned conclusion `NEUTRAL` with the details: `Review limit reached. You've used all free OSS reviews for now. Wait for the free limit to reset to keep reviewing this public repository.`
  - The check run status completed, but no substantive code review was performed on the latest commit.
- **Merge Verdict Policy Rule**:
  - A `NEUTRAL` conclusion from CodeRabbit must never be treated as verification success.
  - The adapter parses the comment body or check output for strings such as `Review limit reached` or markers such as `<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->`.
  - When rate-limited, the reviewer state is classified as `RATE_LIMITED` / `INCOMPLETE`.

### 2.2. Sourcery

- **Identity**: External GitHub integration (`sourcery-ai`, `sourcery-ai[bot]`).
- **Artifacts Emitted**:
  - Top-level PR summary comment containing a Reviewer's Guide and Mermaid flow diagrams.
  - Inline review comments with clear severity indicators (e.g. `High`, `Medium`, `Low`).
  - GitHub Check run named `Sourcery review`.
- **Observed Behavior on Reference PRs**:
  - In PR #119, Sourcery posted findings such as `High · Previous defaults carry over` and `Medium · First match passes mode test`.
  - When a subsequent commit addressed the finding, Sourcery edited its original comment to prepend: `Addressed in [commit_sha]: [description of fix]`.
  - Sourcery bot (`sourcery-ai[bot]`) then programmatically called GitHub's GraphQL API to mark the review thread as resolved (`isResolved: true`).
- **Merge Verdict Policy Rule**:
  - Sourcery thread resolutions (`resolvedBy.login == "sourcery-ai[bot]"`) accompanied by explicit commit acknowledgements are treated as strong evidence of reconciliation.
  - However, the referenced commit SHA must match an ancestor of the current PR head.

### 2.3. OpenAI / ChatGPT Codex Connector

- **Identity**: Connected GitHub App (`chatgpt-codex-connector`, `chatgpt-codex-connector[bot]`).
- **Artifacts Emitted**:
  - Inline review comments formatted with severity badges: `P2 Badge` (`<!-- codex-code-review-finding:v1 -->`).
  - A persistent top-level summary comment with machine-readable metadata.
- **Observed Behavior on Reference PRs**:
  - In PR #120, Codex posted a machine-readable state comment:

    ```html
    <!-- codex-pull-request-review-summary -->
    <!-- codex-review-state:v1 {"code_review":{"commit_sha":"a895efe284efc2ebf1ef2894c9a093af929cd98f","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->
    ```
  - Crucially, in PR #120, the final PR head commit was `35c286dc84db8dc22ffd3e58b3457a1c77acb019`, whereas the Codex review state recorded commit SHA `a895efe...`.
  - Codex had not re-reviewed the final commit.
- **Merge Verdict Policy Rule**:
  - The adapter parses the `codex-review-state:v1` JSON payload.
  - It compares the recorded `commit_sha` against `pull_request.head.sha`.
  - If the commit SHAs differ, the Codex reviewer status is marked `STALE`, preventing it from satisfying mandatory reviewer completion.

### 2.4. DeepSeek Review

- **Identity**: Repository GitHub Actions workflow (`.github/workflows/deepseek-review.yml`) using `hustcer/deepseek-review@v1`.
- **Artifacts Emitted**:
  - PR review submission with state `COMMENTED` from `github-actions[bot]`.
  - Review body containing explicit verdict headers: `## Verdict: APPROVE / APPROVE WITH MINOR FINDINGS / REQUEST CHANGES / BLOCK`.
  - Sections for `Material Findings`, `Unverified Assumptions`, `Missing Verification`, and `Final Challenge`.
- **Observed Behavior on Reference PRs**:
  - In PR #121, DeepSeek Review ran against commit `6ad1952...` and issued `Verdict: APPROVE WITH MINOR FINDINGS`.
  - In the reference workflow, DeepSeek Review triggers exclusively on `pull_request: types: [ready_for_review]`. It does not automatically run on subsequent `synchronize` (commit push) events.
- **Merge Verdict Policy Rule**:
  - The adapter extracts the commit SHA associated with the review (`review.commit_id`).
  - It parses the Markdown heading `## Verdict:` to extract the decision.
  - If the review commit does not match the latest head commit, or if the verdict is `REQUEST CHANGES` or `BLOCK`, verification fails.

### 2.5. PR-Agent

- **Identity**: Repository GitHub Actions workflow (`.github/workflows/pr-agent.yml`) using `The-PR-Agent/pr-agent`.
- **Artifacts Emitted**:
  - PR conversation comments with marker `<!-- pr-agent:review:full -->`.
  - Markdown tables detailing ticket compliance (e.g. `Ticket compliance analysis`).
- **Observed Behavior on Reference PRs**:
  - Triggers on `ready_for_review` and on comment commands from repository collaborators.
- **Merge Verdict Policy Rule**:
  - The adapter checks whether required ticket compliance sections indicate non-compliance or unresolved concerns.

### 2.6. reviewdog (Actionlint & Biome)

- **Identity**: Repository GitHub Actions workflow (`.github/workflows/reviewdog.yml`).
- **Artifacts Emitted**:
  - GitHub Check runs named `runner / actionlint` and `runner / biome`.
  - Optional inline annotations on lint errors.
- **Merge Verdict Policy Rule**:
  - Handled via standard Check Run verification: both check runs must complete with conclusion `SUCCESS`.

### 2.7. Continuous Integration and Security Checks

- **CI Test Suite**: Check run `runner / test` (workflow `ci.yml` running pnpm typecheck and unit tests).
- **CodeQL**: Check runs `runner / codeql` and `CodeQL`.
- **Codecov**: Check runs `runner / coverage`, `codecov/patch`, and `codecov/project`.
- **Cloudflare Deploy Preview**: Check runs `runner / deploy` and `runner / preview-comment`.
- **Merge Verdict Policy Rule**:
  - Required checks are evaluated strictly against their check run conclusions.

## 3. Normalized Internal Data Schema

Merge Verdict transforms all external reviewer signals into a unified TypeScript data model validated at runtime via Zod schemas.

```typescript
import { z } from "zod";

export const SeveritySchema = z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW", "ADVISORY"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ReviewerStatusSchema = z.enum([
  "PENDING",
  "COMPLETED",
  "STALE",
  "RATE_LIMITED",
  "FAILED",
  "SKIPPED",
  "EXEMPT",
]);
export type ReviewerStatus = z.infer<typeof ReviewerStatusSchema>;

export const NormalizedFindingSchema = z.object({
  id: z.string(),
  reviewerId: z.string(),
  threadId: z.string().optional(),
  title: z.string(),
  description: z.string(),
  filePath: z.string().optional(),
  lineNumber: z.number().optional(),
  severity: SeveritySchema,
  isBlocking: z.boolean(),
  isResolved: z.boolean(),
  resolvedBy: z.string().optional(),
  acknowledgedCommitSha: z.string().optional(),
  rawCommentUrl: z.string().url().optional(),
});
export type NormalizedFinding = z.infer<typeof NormalizedFindingSchema>;

export const ReviewerExecutionRecordSchema = z.object({
  reviewerId: z.string(),
  reviewerName: z.string(),
  status: ReviewerStatusSchema,
  evaluatedCommitSha: z.string().nullable(),
  isFresh: z.boolean(),
  verdict: z.enum(["APPROVE", "CHANGES_REQUESTED", "COMMENTED", "NONE"]),
  summary: z.string().optional(),
  findings: z.array(NormalizedFindingSchema),
  checkRunConclusion: z.string().nullable(),
});
export type ReviewerExecutionRecord = z.infer<typeof ReviewerExecutionRecordSchema>;

export const CheckRunRecordSchema = z.object({
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped"])
    .nullable(),
  commitSha: z.string(),
  detailsUrl: z.string().url().optional(),
});
export type CheckRunRecord = z.infer<typeof CheckRunRecordSchema>;

export const ReviewSnapshotSchema = z.object({
  repository: z.string(),
  pullRequestNumber: z.number(),
  headSha: z.string(),
  baseSha: z.string(),
  isDraft: z.boolean(),
  stateFingerprint: z.string(),
  reviewers: z.record(z.string(), ReviewerExecutionRecordSchema),
  unresolvedThreadCount: z.number(),
  blockingDecisionCount: z.number(),
  checkRuns: z.record(z.string(), CheckRunRecordSchema),
  capturedAt: z.string().datetime(),
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;
```

## 4. Distinguishing Facts from Assumptions

| Element                                                    | Status             | Supporting Evidence / Validation Requirement                                                                                                                  |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeRabbit neutral check runs on rate limit                | Verified Fact      | Observed directly in SnapTally PR #119, #120, #121 check run rollups.                                                                                         |
| Sourcery `Addressed in [sha]` comment modification         | Verified Fact      | Observed in SnapTally PR #119 review thread `PRRT_kwDOUey2HM6w-DWe`.                                                                                          |
| Sourcery bot resolving GitHub review threads               | Verified Fact      | Confirmed in GraphQL query for PR #119 (`resolvedBy.login: "sourcery-ai[bot]"`).                                                                              |
| Codex review summary JSON marker (`codex-review-state:v1`) | Verified Fact      | Observed in SnapTally PR #120 comment `IC_kwDOUey2HM8AAAABgoJ9MA`.                                                                                            |
| Codex commit SHA divergence from PR head                   | Verified Fact      | Verified in SnapTally PR #120: Codex reviewed `a895efe`, PR merged at `35c286d`.                                                                              |
| DeepSeek Review textual verdict format                     | Verified Fact      | Observed in SnapTally PR #121 review by `github-actions[bot]`.                                                                                                |
| Reviewer adapters stability across bot updates             | Working Assumption | External bots may update Markdown formatting or comment markers without notice. Regex patterns must be resilient and supplemented by GraphQL thread metadata. |
| Custom reviewer config extensibility                       | Proposed Design    | Adapters are designed as pure TypeScript modules with standardized interfaces to allow community additions without core engine modification.                  |
