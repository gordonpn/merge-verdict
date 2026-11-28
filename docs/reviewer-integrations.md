# Reviewer Integrations Specification

## 1. Overview and Integration Landscape

Merge Verdict reconciles feedback from a wide array of automated pull request review tools. Rather than attempting to re-analyze code diffs directly, Merge Verdict consumes the structured data, inline comments, top-level reviews, and check runs emitted by these tools.

This document details:

1. Concrete behaviors observed across real-world pull requests in the reference repository [gordonpn/snaptally](https://github.com/gordonpn/snaptally) (specifically PRs #119, #120, and #121).
2. The normalized internal schema used to represent findings and reviewer states.
3. Specific parsing and reconciliation rules for each reviewer integration.
4. Clear distinctions between verified platform behaviors and working assumptions requiring validation.

For the repository workflows' event, identity, credential, and cancellation boundaries, see the [optional reviewer validation matrix](reviewer-workflow-validation.md).

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
  - Snapshot callers must supply verified ancestor SHAs through `NormalizeSnapshotOptions.ancestorCommitShas`. The collector does not collect commit ancestry; base and head revisions alone do not prove intermediate ancestry. Without this evidence, only acknowledgements matching the current head can establish reconciliation. Abbreviated SHAs must uniquely match a known commit, ignoring hexadecimal case.

### 2.3. OpenAI / ChatGPT Codex Connector

A failed state artifact containing the connector's explicit quota-exhaustion notice is
classified `RATE_LIMITED` only when its `code_review.commit_sha` matches the PR head.
Unresolved findings still produce `CHANGES_REQUESTED`. A separate quota notice without
revision provenance cannot explain a SHA-bearing failure and leaves it `FAILED`.
Timestamp proximity alone does not establish that two artifacts describe the same run.
Only explicit diagnostic prose using the captured connector wording is recognized;
quoted history, code examples and state JSON text cannot classify a failure as quota exhaustion.
Unknown diagnostic wording remains `FAILED` until its meaning is verified.

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
  - In `.github/workflows/deepseek-review.yml`, DeepSeek Review is opt-in (`vars.ENABLE_DEEPSEEK_REVIEW == 'true'`) and triggers on `pull_request` (`opened`, `ready_for_review`, and `synchronize` for non-draft same-repository non-bot PRs) and on open-PR `issue_comment` (`created`, `edited`) `/review` requests from repository `OWNER`, `MEMBER`, or `COLLABORATOR` non-bot accounts targeting non-draft same-repository non-bot PRs. When enabled, eligible runs validate `DEEPSEEK_API_KEY` and fail explicitly if it is missing, empty, or whitespace-only.
- **Merge Verdict Policy Rule**:
  - The adapter extracts the commit SHA associated with the review (`review.commit_id`).
  - Material findings support bullets, numbered lists, and numbered level-three subsections within the material findings section. Subsection descriptions retain their supporting text and nested bullets. Parsing stops at sibling sections or non-finding level-three headings. The producer prompt requires one consistent format throughout the material findings section: list entries or numbered subsections, without mixing them or using standalone paragraphs. Bullets beneath a numbered subsection are supporting detail of that finding. Bold labels support both `**LOW:**` and `**LOW**:` colon placement. Each finding preserves an explicit severity prefix (`BLOCKER`, `CRITICAL` mapped to `BLOCKER`, `HIGH`, `MEDIUM`, `LOW`, `ADVISORY`, or `INFO` mapped to `ADVISORY`) when present and falls back to the verdict-derived default otherwise (`BLOCK` to `BLOCKER`, `REQUEST CHANGES` to `HIGH`, `APPROVE WITH MINOR FINDINGS` to `LOW`, `APPROVE` to `MEDIUM`); under `REQUEST CHANGES` or `BLOCK`, `BLOCKER`/`HIGH`/`MEDIUM` findings block while `LOW`/`ADVISORY` remain non-blocking, and all material findings stay open (`isResolved: false`) so policy evaluation can still apply `blocking_severity_threshold` and `allow_advisory_exemptions` and the check report lists them as open findings, whereas under `APPROVE` or `APPROVE WITH MINOR FINDINGS`, findings are marked `isResolved: true`.
  - The producer prompt requires the exact level-two headings `## Verdict: <verdict>` and `## Material Findings`, with one supported verdict in place of `<verdict>`. Alongside `## Verdict: <verdict>` headings, the adapter also recognizes standalone top-level bold verdict lines (`**Verdict: <verdict>**`, `**Verdict:** <verdict>`, `**Verdict**: <verdict>`, and `__` equivalents) outside fenced code blocks and blockquotes when the verdict matches one of the four supported values exactly. Code-span and strike delimiters around a bold verdict value are rejected. Verdicts inside code fences, blockquotes or list paragraph continuations, inline prose mentions, and trailing prose after a bold verdict are ignored. Missing verdicts fall back to check-run status (`SKIPPED`/`FAILED`/`PENDING` rather than approval). The latest qualifying current-head review takes precedence over later submissions for older heads. Conflicting verdicts fail closed (`FAILED`), retaining material findings as unresolved under conservative blocking-verdict rules even when the reviewer is optional. Material findings are read from their level-two or level-three section heading, never an earlier prose mention.
  - If the review commit does not match the latest head commit, or if the verdict is `REQUEST CHANGES` or `BLOCK`, verification fails.

### 2.5. PR-Agent

- **Identity**: Repository GitHub Actions workflow (`.github/workflows/pr-agent.yml`) using `docker://pragent/pr-agent` (`The-PR-Agent/pr-agent`).
- **Runtime Image Pinning**:
  - `.github/workflows/pr-agent.yml` pins the runtime container image by immutable OCI digest (`docker://pragent/pr-agent@sha256:548e894a88071180832b2f4233f734d0acd0db1a879e2fcbaa70bac8b8372ebe`), corresponding to upstream release tag `0.50.0-github_action` built by `The-PR-Agent/pr-agent/.github/workflows/publish.yml@refs/tags/v0.50.0` (verified via SLSA provenance attestation).
  - **Invocation Contract**: The [pinned wrapper metadata](https://github.com/The-PR-Agent/pr-agent/blob/e673a02076ce09a4726c3d0c3cc85780e59ca52b/action.yaml) declares no outputs, entrypoint override, or arguments. Its only inputs are optional artifact context inputs, unused by this workflow. The `github_action` image starts `pr_agent.servers.github_action_runner`; it reads the dotted environment settings directly. Downstream publication consumes the host file sink and `steps.pr_agent.outcome`, not action outputs. [Hosted run 45549723891](https://github.com/gordonpn/merge-verdict/actions/runs/45549723891) exercised the pinned digest, persistent state, publication, and provenance upload.
  - **Digest-Update Procedure**:
    1. Resolve the release tag digest (formatted as `sha256:<hex>`): `docker buildx imagetools inspect pragent/pr-agent:<version>-github_action --format '{{.Manifest.Digest}}'`.
    2. Verify its GitHub Artifact Attestation: `gh attestation verify "oci://index.docker.io/pragent/pr-agent@<digest>" --repo The-PR-Agent/pr-agent --signer-workflow The-PR-Agent/pr-agent/.github/workflows/publish.yml --source-ref "refs/tags/v<version>"`.
    3. Update `.github/workflows/pr-agent.yml` with `docker://pragent/pr-agent@<digest>` and the tag comment. Update this section's pinned digest, release tag, source/provenance relationship, and invocation evidence to match the verified image.
    4. Run `just lint-workflows` and `just check-docs`.
    5. Confirm hosted `runner / pr-agent` produces valid provenance before merging.
- **Artifacts Emitted**:
  - PR conversation comments with marker `<!-- pr-agent:review:full -->` and persistent state marker `<!-- pr-agent-review-state:v1 -->`.
  - Markdown tables detailing ticket compliance when enabled (`PR_REVIEWER.REQUIRE_TICKET_ANALYSIS_REVIEW`).
  - Workflow artifact `pr-agent-review-provenance-pr-<number>` (with collector compatibility for legacy `pr-agent-review-provenance`, containing `pr-agent-provenance.json`) emitted by `.github/workflows/pr-agent.yml` binding `workflow_path`, `run_id`, `repository`, `pull_request_number`, `head_sha`, `comment_id`, and `body_digest`.
- **Observed Behavior on Reference PRs**:
  - Opt-in via `vars.ENABLE_PR_AGENT == 'true'`, triggering on `pull_request` (`opened`, `ready_for_review`, and `synchronize` with `HANDLE_PUSH_TRIGGER` running `/review` for non-draft same-repository non-bot PRs) and on open-PR `issue_comment` (`created`, `edited`) leading slash commands (`/review`, `/describe`, `/improve`, `/ask`) from repository `OWNER`, `MEMBER`, or `COLLABORATOR` non-bot accounts targeting non-draft same-repository non-bot PRs. When enabled, eligible runs validate `DEEPSEEK_API_KEY` and fail explicitly if it is missing, empty, or whitespace-only.
  - Repository producer defaults in `.github/workflows/pr-agent.yml` set `PR_REVIEWER.REQUIRE_TICKET_ANALYSIS_REVIEW: "false"`, `PR_REVIEWER.PERSISTENT_FINDING_STATE: "true"`, `PR_REVIEWER.NUM_MAX_FINDINGS: "10"`, `PR_REVIEWER.MAX_PREVIOUS_FINDINGS_CHARS: "0"`, and `PR_REVIEWER.EXTRA_INSTRUCTIONS` instructing the reviewer to report only concrete defects in `key_issues_to_review` (excluding confirmed-safe behavior, accepted design choices that cause no concrete defect, and speculative confirm/verify notes, while retaining documented tradeoffs that cause concrete correctness, security, data-loss, or contract defects). Disabling producer-side ticket analysis avoids turning partial-milestone `Refs #...` tracking epics into spurious non-compliance blocks while Merge Verdict checks issue links via `verification.require_issue_links`. Raising `NUM_MAX_FINDINGS` above the upstream default (`3`) avoids `len(current_findings) < max_findings` marking 3-finding reviews as `complete: false` (`kind: "partial"`), and setting `MAX_PREVIOUS_FINDINGS_CHARS: "0"` stops the LLM prompt from echoing superseded `ACTIVE` finding prose across pushes while keeping structured `finding_id` state reconciliation intact.
- **Merge Verdict Policy Rule**:
  - The adapter checks whether required ticket compliance sections indicate non-compliance or unresolved concerns whenever ticket compliance sections appear in a comment.
  - Non-compliant requirement bullets become HIGH blocking findings. Compliant and human-verification sections do not become findings. Structured finding states RESOLVED and FIXED clear a concern; other states remain unresolved.
  - A repository-bound full commit header or valid v1 state establishes review provenance. Unknown provenance retains concerns as PENDING, never APPROVE. A malformed state marker cannot fall back to a header to imply that omitted structured findings are resolved.
  - A proven older review stays STALE with its own SHA and no carried findings, even when a current workflow succeeds. An older workflow cannot override a proven current review. Current pending or unsuccessful checks block a current review; unsupported completed conclusions, including null, fail closed.
  - A successful workflow without a review is SKIPPED, not approval. A successful workflow with an unprovenanced review leaves that review PENDING. Consumers must inspect status and verdict together with freshness.
  - Shared `github-actions` or `github-actions[bot]` authorship and HTML markers do not identify the producing workflow. The producer enables upstream's host-only local file sink, validates the generated review's repository, PR, and head, then publishes a separate comment. Provenance schema version 2 records the ID and exact body digest from that posting response. It never searches shared-bot comments to choose what to attest. The original persistent review remains available to upstream state reconciliation; each review run intentionally adds one separately attested comment. Missing or ambiguous output, obsolete heads, failed writes, and mismatched receipts fail the job without provenance. Non-review commands do not invoke this publisher.
  - `createGitHubCollector` enables provenance by default; direct construction defaults to opt-out for legacy replay. The collector verifies the workflow path and version 2 artifact, rejecting version 1 selection-based artifacts. Consumers must grant `actions: read` and rerun `/review` after upgrading. Check-linked and comment-triggered candidates are ordered together by update time. Fallback discovery remains bounded to three pages, 25 candidate scans, and five matching-artifact inspections; known check-linked runs remain eligible outside those fallback limits. Unexpected discovery errors abort collection instead of accepting possibly older evidence. This is bounded discovery, not proof of globally newest evidence outside those bounds.
  - With provenance supplied, only the attested comment ID, exact body digest, and head can establish completion. Missing or unavailable evidence and later body edits fail closed while retaining concerns for triage. Check runs with a present non-GitHub-Actions app slug are rejected. A trusted workflow, action runtime, local sink, and publisher are still required; this does not isolate a compromised workflow or runner. Offline inputs omitting provenance retain legacy header/state behavior. See [security](security.md) and the [posting-response decision](decisions.md#2026-11-23-bind-pr-agent-provenance-to-the-comment-write-response).
  - Artifacts request seven-day retention. Expired, deleted, or HTTP 410 artifacts cannot establish completion; collection continues to other candidates within its bounds. If no matching evidence remains, request a fresh `/review`. `/ask` and `/describe` do not renew review provenance. A partial upstream review preserves unresolved state, including older findings, until a complete review can reconcile it; a successful job and authenticated artifact do not imply a completed review.
  - When multiple PR-Agent comments exist on a PR, authenticated provenance selects the attested comment first; otherwise provenance prefers the latest comment whose proven state or repository-bound header commit matches the current PR head SHA (canonicalized lowercase for 40-character hexadecimal SHAs across normalizer and policy evaluation) over a newer stale-SHA comment edited later, while preserving conservative PENDING handling for a newer SHA-less comment when no proven-current comment exists.
  - State parsing scans JSON object boundaries before matching the closing `-->` HTML comment terminator so literal `-->` inside finding text does not truncate valid state, while malformed JSON, unclosed terminators, and trailing content before `-->` remain fail-closed (`PENDING`, never recovering approval via header).
  - Ticket compliance parsing is bounded to the first `Ticket compliance analysis` section up to `</td>`, `</table>`, or a sibling `##` heading, and retains wrapped-reference continuation lines and multi-ticket bullets under `Non-compliant requirements:` without crossing subsequent ticket headers.
  - Captured and synthetic fixtures under `tests/fixtures/pr-agent/` carry provenance labels verifying supported comment and state formats without live workflow execution; end-to-end hosted replay remains tracked separately in #127, #148, #72, and #12.

### 2.6. reviewdog (Actionlint)

- **Identity**: Repository GitHub Actions workflow (`.github/workflows/reviewdog.yml`).
- **Artifacts Emitted**:
  - GitHub Check run named `runner / actionlint` (path-scoped to `.github/workflows/**` and `.github/actionlint.y*ml` changes).
  - Optional inline annotations on workflow lint errors (Biome checks run in `ci.yml` via `just lint`).
- **Merge Verdict Policy Rule**:
  - Omit `runner / actionlint` from `required_checks` in `.github/merge-verdict.yml` because `reviewdog.yml` is path-scoped (GitHub does not emit a check run when no workflow or Actionlint files change) and skips on fork PRs. When configured as a required check in repositories without path filtering, it must complete with conclusion `SUCCESS`.

### 2.7. Continuous Integration and Security Checks

- **CI Test Suite**: Check run `runner / test` (workflow `ci.yml` running pnpm typecheck and unit tests).
- **CodeQL**: Check runs `runner / codeql` and `CodeQL`.
- **Codecov**: Check runs `runner / coverage`, `codecov/patch`, and `codecov/project`.
- **Cloudflare Deploy Preview**: Check runs `runner / deploy` and `runner / preview-comment`.
- **Merge Verdict Policy Rule**:
  - Required checks are evaluated strictly against their check run conclusions.

### 2.8. GitHub Copilot Code Review

- **Identity**: Native GitHub reviewer integration (`copilot-pull-request-reviewer[bot]`).
- **Artifacts Emitted**:
  - Pull request review submissions with state `COMMENTED` or `APPROVE` (when Copilot approvals are enabled in repository settings), including an explicit approval readiness assessment.
  - Inline review comment threads on modified lines.
- **Platform Capabilities (October 2026 GA)**:
  - **Programmatic Review Requests**: Copilot code reviews can be requested via GitHub REST and GraphQL APIs with per-request effort selection (`Lite`, `Balanced`, `Max`).
  - **Qualifying Formal Approvals**: When enabled by repository administrators, Copilot `APPROVE` reviews can count toward required pull request review thresholds (optionally restricted to up to 15 allowed file-path patterns) and are automatically dismissed when new commits are pushed.
  - **Cost and Credit Tiers**: GitHub estimates rough per-review credit costs at approximately $0.25 (`Lite`), $1.50 (`Balanced`), and $10.00 (`Max`). `Max` runs multiple reviewing agents across models and reconciles findings via an aggregation agent, so it should be reserved for high-risk path tiers rather than run on every push.
- **Dual Role in Merge Verdict**:
  1. **Normalized Reviewer**: Merge Verdict ingests `copilot-pull-request-reviewer[bot]` reviews, checks whether the reviewed commit (`review.commit_id`) matches `pull_request.head.sha`, and verifies that all inline threads created by Copilot are resolved.
  2. **Optional Approval Provider (`github_copilot`)**: When configured under `approval.providers`, Merge Verdict can request or await a Copilot review for `head_sha` (selecting effort based on the matched path risk tier) and verify whether GitHub recognizes its formal `APPROVE` review.
- **Trust Boundary and Staleness Constraints**:
  - **Head-Branch Instruction Risk**: GitHub Copilot reads custom instructions and skills from the pull request's head branch rather than the protected base branch, meaning an unmerged PR can alter instructions that influence its own Copilot review. Merge Verdict mitigates this by loading `.github/merge-verdict.yml` exclusively from the protected base branch.
  - **Review-Only Staleness**: A Copilot approval is dismissed on new commits, but is not invalidated when CodeRabbit, Sourcery, or Codex posts a new blocking finding on an unchanged commit SHA. Therefore, the `merge-verdict` required check run remains mandatory alongside native Copilot approval.

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

### Finding locations and source links

The runtime finding schema in `src/models/finding.ts` accepts an optional positive
integer `startLineNumber`. It requires a positive integer `lineNumber` and cannot
exceed that ending line. CodeRabbit, Copilot, Sourcery, and Codex preserve a
multiline start only when it is strictly below the end. They select a valid
current end and its current start together, otherwise a valid original end and
its original start, without mixing the two ranges. Missing or invalid ends leave
the finding visible without a line number.

`rawCommentUrl` retains its existing source-link contract. In particular, Copilot
uses the path, commit identity, and ending line from the same comment, independent
of the thread's range. The URL anchors only the ending line; consumers should use
`startLineNumber` and `lineNumber` for the normalized range.

The collector exposes GraphQL `changedFiles` entries with `path` and nullable
`changeType` alongside the existing `changedFilePaths`. The additive fields remain
optional for existing typed callers; omitted range/change-type fields in legacy
collector payloads become null. This does not provide REST `previous_filename`
rename mappings. Issue #26 remains open for that remaining rename requirement
and its literal 100% normalizer coverage requirement; historical provenance stays
coordinated with #77.

## 4. Distinguishing Facts from Assumptions

| Element                                                    | Status             | Supporting Evidence / Validation Requirement                                                                                                                  |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeRabbit neutral check runs on rate limit                | Verified Fact      | Observed directly in SnapTally PR #119, #120, #121 check run rollups.                                                                                         |
| Sourcery `Addressed in [sha]` comment modification         | Verified Fact      | Observed in SnapTally PR #119 review thread `PRRT_kwDOUey2HM6w-DWe`.                                                                                          |
| Sourcery bot resolving GitHub review threads               | Verified Fact      | Confirmed in GraphQL query for PR #119 (`resolvedBy.login: "sourcery-ai[bot]"`).                                                                              |
| Codex review summary JSON marker (`codex-review-state:v1`) | Verified Fact      | Observed in SnapTally PR #120 comment `IC_kwDOUey2HM8AAAABgoJ9MA`.                                                                                            |
| Codex commit SHA divergence from PR head                   | Verified Fact      | Verified in SnapTally PR #120: Codex reviewed `a895efe`, PR merged at `35c286d`.                                                                              |
| DeepSeek Review textual verdict format                     | Verified Fact      | Observed in SnapTally PR #121 review by `github-actions[bot]`.                                                                                                |
| Copilot reviewer identity and API effort levels            | Verified Fact      | Documented in GitHub Changelog (Oct 2026): `copilot-pull-request-reviewer[bot]`, REST/GraphQL review requests, `Lite`/`Balanced`/`Max` effort tiers.          |
| Copilot reads instructions from PR head branch             | Verified Fact      | Documented in GitHub Docs; requires Merge Verdict to enforce base-branch policy loading as a trust-boundary safeguard.                                        |
| Reviewer adapters stability across bot updates             | Working Assumption | External bots may update Markdown formatting or comment markers without notice. Regex patterns must be resilient and supplemented by GraphQL thread metadata. |
| Custom reviewer config extensibility                       | Proposed Design    | Adapters are designed as pure TypeScript modules with standardized interfaces to allow community additions without core engine modification.                  |
