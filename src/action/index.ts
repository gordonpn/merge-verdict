import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import {
  type CollectPullRequestInput,
  createGitHubCollector,
  type GitHubPullRequestData,
} from "../collector/github-collector.js";
import { DEFAULT_CONFIG_FILE_PATH, parseConfig } from "../config/loader.js";
import { VERSION } from "../index.js";
import type { ReviewSnapshot } from "../models/snapshot.js";
import {
  buildReviewSnapshotFromPullRequest,
  type ReviewerNormalizer,
} from "../normalizers/index.js";
import { evaluatePolicy, type PolicyEvaluation, type PolicyVerdict } from "../policy/evaluator.js";
import { checkIssueLinks } from "../policy/issue-links.js";
import { evaluateRiskTier, type RiskTierEvaluation } from "../policy/risk-tier.js";
import {
  type ChecksClient,
  createOctokitChecksClient,
  publishCheckRun,
  publishErrorCheckRun,
} from "../publisher/checks-api.js";
import { type ChecksReport, formatChecksReport } from "../publisher/checks-formatter.js";

/**
 * Bot identities that Merge Verdict ignores to prevent self-triggering loops.
 */
export const SELF_BOT_ACTORS = ["merge-verdict[bot]", "github-actions[bot]"] as const;

/**
 * Terminal verdict values emitted by the GitHub Action entry point.
 */
export type ActionVerdict = PolicyVerdict | "SKIPPED_SELF_EVENT";

/**
 * Minimal collector interface used by the GitHub Action entry point.
 */
export interface PullRequestCollector {
  collectPullRequest(input: CollectPullRequestInput): Promise<GitHubPullRequestData>;
}

/**
 * Event context inspected by the self-triggering loop guard.
 */
export interface SelfTriggerContext {
  readonly eventName?: string | undefined;
  readonly actor?: string | undefined;
  readonly payload?: Record<string, unknown> | null | undefined;
  readonly requiredCheckName?: string | undefined;
}

/**
 * Outcome of checking whether a workflow run was triggered by Merge Verdict itself.
 */
export interface SelfTriggerResult {
  readonly skipped: boolean;
  readonly reason: string | null;
}

/**
 * Validated owner and repository pair.
 */
export interface RepositoryCoordinates {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
}

/**
 * Runtime options for deterministic testing and dependency injection.
 */
export interface ActionRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly collector?: PullRequestCollector;
  readonly checksClient?: ChecksClient;
  readonly createChecksClient?: (token: string) => ChecksClient;
  readonly createCollector?: (token: string) => PullRequestCollector;
  readonly now?: () => Date;
  readonly normalizers?: readonly ReviewerNormalizer[];
  readonly codeEvidenceSatisfied?: boolean;
  readonly repositoryRules?: readonly { id: string; satisfied: boolean }[];
  readonly requireIssueLink?: boolean;
  readonly pullRequestBody?: string | null;
}

/**
 * Structured result returned by a single GitHub Action execution.
 */
export interface ActionRunResult {
  readonly verdict: ActionVerdict;
  readonly summary: string;
  readonly report: string;
  readonly exitCode: 0 | 1;
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly repository: string | null;
  readonly pullRequestNumber: number | null;
  readonly headSha: string | null;
  readonly snapshot: ReviewSnapshot | null;
  readonly riskTier: RiskTierEvaluation | null;
  readonly evaluation: PolicyEvaluation | null;
  readonly checksReport: ChecksReport | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isSelfBotLogin(login: string | undefined | null): boolean {
  if (!login) {
    return false;
  }
  const normalized = login.trim().toLowerCase();
  return SELF_BOT_ACTORS.some((bot) => bot.toLowerCase() === normalized);
}

/**
 * Reads a GitHub Actions input from environment variables without external dependencies.
 * Supports both hyphenated (`INPUT_GITHUB-TOKEN`) and underscored (`INPUT_GITHUB_TOKEN`) forms.
 */
export function getActionInput(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const hyphenKey = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  const underscoreKey = `INPUT_${name.replace(/[- ]/g, "_").toUpperCase()}`;
  const raw = env[hyphenKey] ?? env[underscoreKey] ?? "";
  return raw.trim();
}

/**
 * Parses a boolean GitHub Action input string.
 */
export function parseBooleanInput(raw: string | undefined, defaultValue = false): boolean {
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new TypeError(`Invalid boolean input value: "${raw}". Expected "true" or "false".`);
}

/**
 * Writes a single-line or multiline output parameter to the `GITHUB_OUTPUT` file.
 */
export function writeActionOutput(
  name: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const outputPath = env.GITHUB_OUTPUT?.trim();
  if (!outputPath) {
    return;
  }
  const delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
  appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

/**
 * Appends Markdown content to the `GITHUB_STEP_SUMMARY` file.
 */
export function appendStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
  const summaryPath = env.GITHUB_STEP_SUMMARY?.trim();
  if (!summaryPath) {
    return;
  }
  const normalized = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  appendFileSync(summaryPath, normalized, "utf8");
}

/**
 * Reads and parses the JSON webhook event payload from `GITHUB_EVENT_PATH`.
 */
export function loadEventPayload(eventPath: string | undefined): Record<string, unknown> | null {
  const trimmedPath = eventPath?.trim();
  if (!trimmedPath) {
    return null;
  }
  const raw = readFileSync(trimmedPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const record = asRecord(parsed);
  if (record === null) {
    throw new TypeError("GitHub event payload root must be a JSON object.");
  }
  return record;
}

function getNestedString(
  parent: Record<string, unknown> | null | undefined,
  childKey: string,
  leafKey: string,
): string {
  const child = asRecord(parent?.[childKey]);
  const value = child?.[leafKey];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Evaluates mandatory loop-prevention guards from `docs/events-and-state.md` Section 2.2.
 */
export function isSelfTriggeredEvent(context: SelfTriggerContext): SelfTriggerResult {
  const eventName = context.eventName?.trim() ?? "";
  const actor = context.actor?.trim() ?? "";
  const payload = context.payload ?? null;
  const requiredCheckName = (context.requiredCheckName?.trim() || "merge-verdict").toLowerCase();

  if (eventName === "check_run") {
    const checkRun = asRecord(payload?.check_run);
    const checkName = typeof checkRun?.name === "string" ? checkRun.name.trim() : "";
    if (
      checkName.toLowerCase() === requiredCheckName ||
      checkName.toLowerCase() === "merge-verdict"
    ) {
      return {
        skipped: true,
        reason: `Ignored check_run event for self check "${checkName}".`,
      };
    }
  }

  if (eventName === "pull_request_review") {
    const reviewLogin = getNestedString(asRecord(payload?.review), "user", "login");
    if (isSelfBotLogin(reviewLogin)) {
      return {
        skipped: true,
        reason: `Ignored pull_request_review event authored by "${reviewLogin}".`,
      };
    }
  }

  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    const commentLogin = getNestedString(asRecord(payload?.comment), "user", "login");
    if (isSelfBotLogin(commentLogin)) {
      return {
        skipped: true,
        reason: `Ignored ${eventName} event authored by "${commentLogin}".`,
      };
    }
  }

  if (isSelfBotLogin(actor)) {
    return {
      skipped: true,
      reason: `Ignored event triggered by bot actor "${actor}".`,
    };
  }

  if (eventName !== "workflow_dispatch") {
    const senderLogin = getNestedString(payload, "sender", "login");
    if (isSelfBotLogin(senderLogin)) {
      return {
        skipped: true,
        reason: `Ignored event triggered by bot sender "${senderLogin}".`,
      };
    }
  }

  return { skipped: false, reason: null };
}

/**
 * Validates and extracts `owner/repo` coordinates from `GITHUB_REPOSITORY` or event payload.
 */
export function parseRepository(
  rawRepository: string | undefined,
  payload?: Record<string, unknown> | null,
): RepositoryCoordinates | null {
  const fallbackFullName = getNestedString(payload, "repository", "full_name");
  const candidate = rawRepository?.trim() || fallbackFullName;
  if (!candidate) {
    return null;
  }

  const parts = candidate.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const [owner, repo] = parts;
  const segmentPattern = /^[A-Za-z0-9_.-]+$/;
  if (
    !owner ||
    !repo ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !segmentPattern.test(owner) ||
    !segmentPattern.test(repo)
  ) {
    return null;
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
  };
}

function parsePositiveSafeInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[1-9][0-9]*$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Extracts and validates a positive safe integer pull request number from inputs or webhook payload.
 */
export function extractPullRequestNumber(
  inputPullRequestNumber: string | undefined,
  payload?: Record<string, unknown> | null,
): number | null {
  if (inputPullRequestNumber !== undefined && inputPullRequestNumber.trim() !== "") {
    return parsePositiveSafeInteger(inputPullRequestNumber);
  }

  if (!payload) {
    return null;
  }

  for (const containerKey of ["inputs", "client_payload"] as const) {
    const container = asRecord(payload[containerKey]);
    for (const key of ["pull_request_number", "pr_number"] as const) {
      const rawVal = container?.[key];
      if (rawVal !== undefined && rawVal !== null && rawVal !== "") {
        return parsePositiveSafeInteger(rawVal);
      }
    }
  }

  const pullRequest = asRecord(payload.pull_request);
  if (pullRequest?.number !== undefined && pullRequest.number !== null) {
    return parsePositiveSafeInteger(pullRequest.number);
  }

  const issue = asRecord(payload.issue);
  if (issue && asRecord(issue.pull_request) !== null && issue.number !== undefined) {
    return parsePositiveSafeInteger(issue.number);
  }

  const checkRun = asRecord(payload.check_run);
  if (Array.isArray(checkRun?.pull_requests) && checkRun.pull_requests.length === 1) {
    const firstPr = asRecord(checkRun.pull_requests[0]);
    if (firstPr?.number !== undefined && firstPr.number !== null) {
      return parsePositiveSafeInteger(firstPr.number);
    }
  }

  return null;
}

function sanitizeDiagnostic(message: string): string {
  const redacted = message.replace(
    /\b(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
    "[REDACTED_TOKEN]",
  );
  return redacted.length > 2000 ? `${redacted.slice(0, 1997)}...` : redacted;
}

function failBeforeSnapshot(params: {
  readonly env: NodeJS.ProcessEnv;
  readonly repository: string | null;
  readonly pullRequestNumber: number | null;
  readonly configPath: string;
  readonly evaluatedAt: string;
  readonly summary: string;
  readonly diagnostic: string;
  readonly noCheckCreatedNotice?: boolean;
}): ActionRunResult {
  const lines: string[] = [
    "# Merge Verdict: ERROR",
    "",
    `Version: ${VERSION}`,
    "",
    `Repository: ${params.repository ?? "unavailable"}`,
    "",
    `Pull request: ${params.pullRequestNumber !== null ? `#${params.pullRequestNumber}` : "unavailable"}`,
    "",
    `Config path: ${params.configPath}`,
    "",
    `Evaluated at: ${params.evaluatedAt}`,
    "",
  ];

  if (params.noCheckCreatedNotice) {
    lines.push(
      "No GitHub check run was created because the target repository or pull request number could not be resolved.",
      "",
    );
  }

  lines.push(
    "## Failure Summary",
    "",
    params.summary,
    "",
    "## Diagnostic Details",
    "",
    params.diagnostic,
    "",
  );
  const report = lines.join("\n");

  writeActionOutput("verdict", "ERROR", params.env);
  writeActionOutput("summary", params.summary, params.env);
  appendStepSummary(report, params.env);
  process.exitCode = 1;

  return {
    verdict: "ERROR",
    summary: params.summary,
    report,
    exitCode: 1,
    skipped: false,
    skipReason: null,
    repository: params.repository,
    pullRequestNumber: params.pullRequestNumber,
    headSha: null,
    snapshot: null,
    riskTier: null,
    evaluation: null,
    checksReport: null,
  };
}

function appendMetadataFooter(params: {
  readonly baseText: string;
  readonly configPath: string;
  readonly policyVersion: string;
  readonly headSha: string;
  readonly risk: RiskTierEvaluation;
  readonly evaluation: PolicyEvaluation;
}): string {
  const lines: string[] = [
    params.baseText.trimEnd(),
    "",
    "## Verification Metadata",
    "",
    `- Engine version: \`${VERSION}\``,
    `- Evaluated head SHA: \`${params.headSha}\``,
    `- Base policy revision: \`${params.policyVersion}\``,
    `- Policy path: \`${params.configPath}\``,
    `- Path risk tier: \`${params.risk.tier ?? "baseline"}\` (effort: \`${params.risk.effort}\`, automated approval: \`${params.risk.automatedApproval}\`, human review required: \`${String(params.risk.requiresHumanReview)}\`, auto-approve eligible: \`${String(params.risk.canAutoApprove)}\`)`,
    "",
    "## Policy Conditions",
    "",
  ];

  if (params.evaluation.reasons.length === 0) {
    lines.push("All 8 policy conditions were satisfied.", "");
  } else {
    lines.push(
      "| Condition | Outcome | Code | Subject |",
      "| --- | --- | --- | --- |",
      ...params.evaluation.reasons.map(
        (reason) =>
          `| ${reason.condition} | ${reason.outcome} | \`${reason.code}\` | \`${reason.subject}\` |`,
      ),
      "",
    );
  }

  return lines.join("\n");
}

function haveSameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  if (sortedLeft.length !== sortedRight.length) {
    return false;
  }
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function formatError(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
}

function buildSnapshot(
  prData: GitHubPullRequestData,
  capturedAt: string,
  normalizers?: readonly ReviewerNormalizer[],
): ReviewSnapshot {
  return buildReviewSnapshotFromPullRequest(prData, {
    capturedAt,
    ...(normalizers ? { normalizers } : {}),
    ...(prData.ancestorCommitShas !== undefined
      ? { ancestorCommitShas: prData.ancestorCommitShas }
      : {}),
  });
}

function hasCollectionDrift(
  initial: GitHubPullRequestData,
  next: GitHubPullRequestData,
  trackBody: boolean,
): boolean {
  return (
    next.baseSha !== initial.baseSha ||
    next.policyVersion !== initial.policyVersion ||
    next.policyContent !== initial.policyContent ||
    !haveSameStringSet(next.changedFilePaths, initial.changedFilePaths) ||
    (trackBody && (next.body ?? null) !== (initial.body ?? null))
  );
}

/**
 * Executes the Merge Verdict GitHub Action workflow entry point.
 */
export async function runAction(options: ActionRuntimeOptions = {}): Promise<ActionRunResult> {
  const env = options.env ?? process.env;
  const evaluatedAt = (options.now?.() ?? new Date()).toISOString();
  const configPath = getActionInput("config-path", env) || DEFAULT_CONFIG_FILE_PATH;

  let payload: Record<string, unknown> | null = null;
  try {
    payload = loadEventPayload(env.GITHUB_EVENT_PATH);
  } catch (error) {
    const diagnostic = formatError(error);
    return failBeforeSnapshot({
      env,
      repository: env.GITHUB_REPOSITORY?.trim() || null,
      pullRequestNumber: null,
      configPath,
      evaluatedAt,
      summary: `ERROR: Failed to read GitHub event payload (${diagnostic}).`,
      diagnostic,
      noCheckCreatedNotice: true,
    });
  }

  const selfTrigger = isSelfTriggeredEvent({
    eventName: env.GITHUB_EVENT_NAME,
    actor: env.GITHUB_ACTOR,
    payload,
  });

  if (selfTrigger.skipped) {
    const summary = `SKIPPED_SELF_EVENT: ${selfTrigger.reason}`;
    const report = [
      "# Merge Verdict: SKIPPED_SELF_EVENT",
      "",
      `Version: ${VERSION}`,
      "",
      summary,
      "",
    ].join("\n");
    writeActionOutput("verdict", "SKIPPED_SELF_EVENT", env);
    writeActionOutput("summary", summary, env);
    appendStepSummary(report, env);
    return {
      verdict: "SKIPPED_SELF_EVENT",
      summary,
      report,
      exitCode: 0,
      skipped: true,
      skipReason: selfTrigger.reason,
      repository: null,
      pullRequestNumber: null,
      headSha: null,
      snapshot: null,
      riskTier: null,
      evaluation: null,
      checksReport: null,
    };
  }

  const repository = parseRepository(env.GITHUB_REPOSITORY, payload);
  const pullRequestNumberInput = getActionInput("pull-request-number", env);
  const pullRequestNumber = extractPullRequestNumber(pullRequestNumberInput, payload);

  if (repository === null || pullRequestNumber === null) {
    const missingParts: string[] = [];
    if (repository === null) {
      missingParts.push("repository (expected owner/repo)");
    }
    if (pullRequestNumber === null) {
      missingParts.push("pull request number (expected positive integer)");
    }
    const diagnostic = `Missing or invalid ${missingParts.join(" and ")} for event "${env.GITHUB_EVENT_NAME ?? "unknown"}".`;
    return failBeforeSnapshot({
      env,
      repository: repository?.fullName ?? null,
      pullRequestNumber,
      configPath,
      evaluatedAt,
      summary: `ERROR: ${diagnostic} No check run was created.`,
      diagnostic,
      noCheckCreatedNotice: true,
    });
  }

  const token = getActionInput("github-token", env) || env.GITHUB_TOKEN?.trim() || "";
  // Only the runner-provided repository identifies the authenticated publication target.
  const trustedRepository = parseRepository(env.GITHUB_REPOSITORY);
  let checksClient: ChecksClient | undefined;
  let trustedHeadSha: string | null = null;
  let failFast = false;
  let initialPrData: GitHubPullRequestData;
  let config: ReturnType<typeof parseConfig>;
  let snapshot: ReviewSnapshot;
  let collector: PullRequestCollector;
  const collectInput: CollectPullRequestInput = {
    owner: repository.owner,
    repo: repository.repo,
    pullRequestNumber,
    configPath,
  };

  try {
    if (trustedRepository === null) {
      throw new Error("No trusted runner repository is available for check publication.");
    }
    checksClient =
      options.checksClient ??
      (
        options.createChecksClient ??
        ((auth: string) => createOctokitChecksClient(new Octokit({ auth })))
      )(token);
    trustedHeadSha = await checksClient.getHeadSha({
      owner: trustedRepository.owner,
      repo: trustedRepository.repo,
      pullNumber: pullRequestNumber,
    });
    if (!/^[a-fA-F0-9]{40}$/.test(trustedHeadSha)) {
      trustedHeadSha = null;
      throw new Error("Authenticated pull request response did not contain a valid head SHA.");
    }
    failFast = parseBooleanInput(getActionInput("fail-fast", env), false);
    collector = options.collector ?? (options.createCollector ?? createGitHubCollector)(token);
    initialPrData = await collector.collectPullRequest(collectInput);
    config = parseConfig(initialPrData.policyContent);
    snapshot = buildSnapshot(initialPrData, evaluatedAt, options.normalizers);
  } catch (error) {
    let diagnostic = formatError(error);
    if (checksClient !== undefined && trustedRepository !== null && trustedHeadSha !== null) {
      try {
        await publishErrorCheckRun(checksClient, {
          owner: trustedRepository.owner,
          repo: trustedRepository.repo,
          pullNumber: pullRequestNumber,
          headSha: trustedHeadSha,
          evaluatedAt,
          errorCode: "PRE_EVALUATION_ERROR",
          errorMessage: diagnostic,
        });
      } catch (publicationError) {
        diagnostic = sanitizeDiagnostic(
          `${diagnostic}; Check publication failed: ${formatError(publicationError)}`,
        );
      }
    }
    return failBeforeSnapshot({
      env,
      repository: repository.fullName,
      pullRequestNumber,
      configPath,
      evaluatedAt,
      summary: `ERROR: Pre-evaluation failure for ${repository.fullName}#${pullRequestNumber} (${diagnostic}).`,
      diagnostic,
    });
  }

  const risk = evaluateRiskTier(initialPrData.changedFilePaths, config);
  const unresolvedThreadIds = initialPrData.reviewThreads
    .filter((thread) => !thread.isResolved)
    .map((thread) => thread.id);

  const requireIssueLink =
    options.requireIssueLink ?? config.verification.requireIssueLinks === true;
  const trackBodyFreshness = requireIssueLink && options.pullRequestBody === undefined;

  const executionErrors: string[] = [];
  let finalSnapshot = {
    headSha: snapshot.headSha,
    stateFingerprint: snapshot.stateFingerprint,
  };

  try {
    const finalPrData = await collector.collectPullRequest(collectInput);
    const finalReviewSnapshot = buildSnapshot(finalPrData, evaluatedAt, options.normalizers);
    const collectionDrifted = hasCollectionDrift(initialPrData, finalPrData, trackBodyFreshness);
    finalSnapshot = {
      headSha: finalReviewSnapshot.headSha,
      stateFingerprint: collectionDrifted
        ? `stale-policy-or-paths:${snapshot.stateFingerprint}`
        : finalReviewSnapshot.stateFingerprint,
    };
  } catch (error) {
    executionErrors.push(formatError(error));
  }

  const repositoryRules = [...(options.repositoryRules ?? [])];
  const pullRequestBody =
    options.pullRequestBody !== undefined ? options.pullRequestBody : (initialPrData.body ?? null);
  if (requireIssueLink) {
    const issueCheck = checkIssueLinks(pullRequestBody);
    repositoryRules.push({
      id: "issue-links",
      satisfied: issueCheck.failureMessage === null,
    });
  }

  const codeEvidenceSatisfied = options.codeEvidenceSatisfied;

  let evaluation = evaluatePolicy({
    snapshot,
    config,
    finalSnapshot,
    executionErrors,
    repositoryRules,
    unresolvedThreadIds,
    ...(config.blockingSeverityThreshold !== undefined
      ? { blockingSeverityThreshold: config.blockingSeverityThreshold }
      : {}),
    ...(config.permittedCheckConclusions !== undefined
      ? { permittedCheckConclusions: config.permittedCheckConclusions }
      : {}),
    ...(codeEvidenceSatisfied !== undefined ? { codeEvidenceSatisfied } : {}),
  });

  try {
    const publication = await publishCheckRun(checksClient, {
      owner: repository.owner,
      repo: repository.repo,
      pullNumber: pullRequestNumber,
      snapshot,
      verdict: evaluation.verdict,
      evaluatedAt,
      requiredChecks: config.requiredChecks,
      getLatestStateFingerprint: async () => {
        if (evaluation.verdict !== "PASS") return finalSnapshot.stateFingerprint;
        const latest = await collector.collectPullRequest(collectInput);
        if (hasCollectionDrift(initialPrData, latest, trackBodyFreshness)) {
          return `stale-policy-or-paths:${snapshot.stateFingerprint}`;
        }
        return buildSnapshot(latest, evaluatedAt, options.normalizers).stateFingerprint;
      },
    });
    evaluation = { ...evaluation, verdict: publication.verdict };
  } catch (error) {
    let diagnostic = formatError(error);
    try {
      await publishErrorCheckRun(checksClient, {
        owner: repository.owner,
        repo: repository.repo,
        pullNumber: pullRequestNumber,
        headSha: snapshot.headSha,
        evaluatedAt,
        errorCode: "PUBLICATION_ERROR",
        errorMessage: diagnostic,
      });
    } catch (invalidationError) {
      diagnostic = sanitizeDiagnostic(
        `${diagnostic}; Blocking check publication also failed: ${formatError(invalidationError)}`,
      );
    }
    return failBeforeSnapshot({
      env,
      repository: repository.fullName,
      pullRequestNumber,
      configPath,
      evaluatedAt,
      summary: `ERROR: Check publication failed (${diagnostic}).`,
      diagnostic,
    });
  }

  const checksReport = formatChecksReport(snapshot, {
    verdict: evaluation.verdict,
    evaluatedAt,
    requiredChecks: config.requiredChecks,
  });

  const report = appendMetadataFooter({
    baseText: checksReport.output.text,
    configPath,
    policyVersion: initialPrData.policyVersion,
    headSha: evaluation.headSha,
    risk,
    evaluation,
  });

  writeActionOutput("verdict", evaluation.verdict, env);
  writeActionOutput("summary", checksReport.output.summary, env);
  appendStepSummary(report, env);

  const isBlockingVerdict =
    evaluation.verdict === "FAIL" ||
    evaluation.verdict === "STALE" ||
    evaluation.verdict === "ERROR";
  const exitCode: 0 | 1 = failFast && isBlockingVerdict ? 1 : 0;
  if (exitCode === 1) {
    process.exitCode = 1;
  }

  return {
    verdict: evaluation.verdict,
    summary: checksReport.output.summary,
    report,
    exitCode,
    skipped: false,
    skipReason: null,
    repository: repository.fullName,
    pullRequestNumber,
    headSha: evaluation.headSha,
    snapshot,
    riskTier: risk,
    evaluation,
    checksReport,
  };
}

/**
 * Determines whether the module should automatically execute `runAction()` on load.
 */
export function shouldAutoRun(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MERGE_VERDICT_DISABLE_AUTORUN === "true") {
    return false;
  }
  if (env.MERGE_VERDICT_FORCE_AUTORUN === "true") {
    return true;
  }
  if (env.VITEST === "true" || env.NODE_ENV === "test") {
    return false;
  }
  return env.GITHUB_ACTIONS === "true";
}

/**
 * Invokes the provided action runner when `shouldAutoRun(env)` is true.
 */
export function executeIfAutoRun(
  env: NodeJS.ProcessEnv = process.env,
  runner: () => Promise<unknown> = () => runAction({ env }),
): void {
  if (shouldAutoRun(env)) {
    void runner().catch((error: unknown) => {
      appendStepSummary(
        `# Merge Verdict: ERROR\n\nUnhandled action error: ${formatError(error)}\n`,
        env,
      );
      process.exitCode = 1;
    });
  }
}

executeIfAutoRun(process.env);
