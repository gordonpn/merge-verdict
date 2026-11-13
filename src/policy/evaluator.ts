import type { MergeVerdictConfig } from "../models/config.js";
import type { ReviewSnapshot } from "../models/snapshot.js";

export type PolicyVerdict = "PASS" | "PENDING" | "FAIL" | "STALE" | "ERROR";
export interface PolicyReason {
  readonly condition: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly outcome: Exclude<PolicyVerdict, "PASS">;
  readonly code: string;
  readonly subject: string;
}
export interface PolicyEvaluationInput {
  readonly snapshot: ReviewSnapshot;
  readonly config: MergeVerdictConfig;
  readonly finalSnapshot: { headSha: string; stateFingerprint: string };
  readonly executionErrors: readonly string[];
  readonly repositoryRules: readonly { id: string; satisfied: boolean }[];
  readonly codeEvidenceSatisfied?: boolean;
  readonly unresolvedThreadIds?: readonly string[];
  readonly blockingSeverityThreshold?: "HIGH" | "MEDIUM" | "LOW";
  readonly permittedCheckConclusions?: Readonly<Record<string, readonly ("neutral" | "skipped")[]>>;
}
export interface PolicyEvaluation {
  readonly verdict: PolicyVerdict;
  readonly headSha: string;
  readonly stateFingerprint: string;
  readonly reasons: readonly PolicyReason[];
  readonly approvalEligibility: "undetermined";
}
function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Evaluates already normalized evidence without I/O or publication.
 * Config must come from the protected base revision. Callers must supply all
 * execution errors, custom-rule results, and a freshly collected final identity.
 * Precedence is ERROR > STALE > FAIL > PENDING > PASS. Approval eligibility is
 * deliberately unresolved here because path risk resolution is a separate stage.
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const { snapshot, config } = input;
  const reasons: PolicyReason[] = [];
  const add = (
    condition: PolicyReason["condition"],
    outcome: PolicyReason["outcome"],
    code: string,
    subject: string,
  ): void => {
    reasons.push({ condition, outcome, code, subject });
  };
  for (const name of [...new Set(config.requiredChecks)].sort()) {
    const run = ownValue(snapshot.checkRuns, name);
    if (!run || run.commitSha !== snapshot.headSha) {
      add(1, "PENDING", "CHECK_MISSING_OR_STALE", name);
    } else if (run.status !== "completed") {
      add(1, "PENDING", "CHECK_INCOMPLETE", name);
    } else if (run.conclusion === null) {
      add(1, "ERROR", "CHECK_CONCLUSION_MISSING", name);
    } else if (run.conclusion !== "success") {
      const conclusion = run.conclusion;
      const permitted =
        (conclusion === "neutral" || conclusion === "skipped") &&
        ownValue(input.permittedCheckConclusions, name)?.includes(conclusion);
      if (!permitted) add(1, "FAIL", "CHECK_FAILED", name);
    }
  }
  const requiredReviewers = [...new Set(config.requiredReviewers)].sort();
  for (const id of requiredReviewers) {
    const reviewer = ownValue(snapshot.reviewers, id);
    if (reviewer?.status === "FAILED") {
      add(2, "ERROR", "REVIEWER_EXECUTION_FAILED", id);
    } else if (reviewer?.status !== "COMPLETED") {
      add(2, "PENDING", "REVIEWER_INCOMPLETE", id);
    }
  }
  const coveredThreads = new Set<string>();
  for (const id of Object.keys(snapshot.reviewers).sort()) {
    const reviewer = ownValue(snapshot.reviewers, id);
    if (!reviewer) continue;
    for (const finding of [...reviewer.findings].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      if (finding.isResolved) continue;
      if (finding.threadId) coveredThreads.add(finding.threadId);
      const severityBlocks =
        finding.severity === "BLOCKER" ||
        finding.severity === "HIGH" ||
        (finding.severity === "MEDIUM" && input.blockingSeverityThreshold !== "HIGH") ||
        (input.blockingSeverityThreshold === "LOW" && finding.severity === "LOW");
      if (finding.isBlocking || severityBlocks || !config.allowAdvisoryExemptions) {
        add(3, "FAIL", "UNRESOLVED_FINDING", finding.id);
      }
    }
  }
  const unresolvedThreadIds = input.unresolvedThreadIds ?? [];
  const distinctThreadIds = new Set(unresolvedThreadIds);
  if (
    distinctThreadIds.size !== snapshot.unresolvedThreadCount ||
    distinctThreadIds.size !== unresolvedThreadIds.length
  ) {
    add(3, "FAIL", "UNRESOLVED_THREAD_IDENTITIES_MISSING_OR_INCONSISTENT", "threads");
  }
  for (const id of [...distinctThreadIds].sort()) {
    if (!coveredThreads.has(id)) add(3, "FAIL", "UNCLASSIFIED_UNRESOLVED_THREADS", id);
  }
  if (snapshot.blockingDecisionCount > 0)
    add(4, "FAIL", "ACTIVE_BLOCKING_DECISIONS", String(snapshot.blockingDecisionCount));
  for (const id of requiredReviewers) {
    if (ownValue(snapshot.reviewers, id)?.verdict === "CHANGES_REQUESTED")
      add(4, "FAIL", "CHANGES_REQUESTED", id);
  }
  for (const id of requiredReviewers) {
    const reviewer = ownValue(snapshot.reviewers, id);
    if (
      reviewer &&
      (!reviewer.isFresh ||
        reviewer.evaluatedCommitSha !== snapshot.headSha ||
        reviewer.status === "STALE")
    ) {
      add(5, "PENDING", "REVIEWER_STALE", id);
    }
  }
  if (
    input.finalSnapshot.headSha !== snapshot.headSha ||
    input.finalSnapshot.stateFingerprint !== snapshot.stateFingerprint
  ) {
    add(6, "STALE", "SNAPSHOT_CHANGED", snapshot.headSha);
  }
  for (const error of [...input.executionErrors].sort()) add(7, "ERROR", "EXECUTION_ERROR", error);
  if (config.verification.requireCodeEvidence && input.codeEvidenceSatisfied !== true) {
    add(
      8,
      input.codeEvidenceSatisfied === false ? "FAIL" : "PENDING",
      input.codeEvidenceSatisfied === false ? "CODE_EVIDENCE_UNSATISFIED" : "CODE_EVIDENCE_MISSING",
      "code-evidence",
    );
  }
  for (const rule of [...input.repositoryRules].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    if (!rule.satisfied) add(8, "FAIL", "REPOSITORY_RULE_UNSATISFIED", rule.id);
  }
  const verdict =
    (["ERROR", "STALE", "FAIL", "PENDING"] as const).find((outcome) =>
      reasons.some((reason) => reason.outcome === outcome),
    ) ?? "PASS";
  return {
    verdict,
    headSha: snapshot.headSha,
    stateFingerprint: snapshot.stateFingerprint,
    reasons,
    approvalEligibility: "undetermined",
  };
}
