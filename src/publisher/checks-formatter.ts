import { z } from "zod";
import {
  type NormalizedFinding,
  type ReviewSnapshot,
  ReviewSnapshotSchema,
} from "../models/index.js";

export interface ChecksReportOptions {
  readonly verdict: "PASS" | "PENDING" | "FAIL" | "STALE" | "ERROR";
  readonly evaluatedAt: string;
  readonly requiredChecks: readonly string[];
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  message: string;
}

export interface ChecksReport {
  output: { title: string; summary: string; text: string };
  annotationBatches: CheckAnnotation[][];
}

const OptionsSchema = z.object({
  verdict: z.enum(["PASS", "PENDING", "FAIL", "STALE", "ERROR"]),
  evaluatedAt: z.string().max(40).datetime(),
  requiredChecks: z.array(z.string().min(1)),
});

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Truncate on Unicode code point boundaries, reserving room for the marker. */
function bounded(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let result = "";
  let used = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8");
    if (used + size > bytes - 3) break;
    result += point;
    used += size;
  }
  return `${result}...`;
}

function cell(value: string): string {
  return bounded(value, 1000)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[|`\\[\]*_~]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/\r\n|\r|\n/g, "<br>");
}

type ReportCell = string | { readonly sourceUrl: string };

function source(value: string | undefined): ReportCell {
  if (
    value === undefined ||
    Buffer.byteLength(value, "utf8") > 1000 ||
    [...value].some((point) => point.charCodeAt(0) <= 32 || point.charCodeAt(0) === 127)
  )
    return "unavailable";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return "unavailable";
    return {
      sourceUrl: url.href
        .replace(
          /[()[\]|<>\\`"'*]/g,
          (point) => `%${point.charCodeAt(0).toString(16).toUpperCase()}`,
        )
        .replaceAll("&", "&amp;"),
    };
  } catch {
    return "unavailable";
  }
}

function row(values: readonly ReportCell[]): string {
  return `| ${values.map((value) => (typeof value === "string" ? cell(value) : `[Source](<${value.sourceUrl}>)`)).join(" | ")} |\n`;
}

function annotation(finding: NormalizedFinding): CheckAnnotation | undefined {
  const path = finding.filePath;
  if (
    path === undefined ||
    path.length === 0 ||
    path.startsWith("/") ||
    [...path].some(
      (point) =>
        point.charCodeAt(0) < 32 || point.charCodeAt(0) === 127 || point === "\\" || point === ":",
    ) ||
    path.split("/").some((part) => part === ".." || part === "." || part.length === 0) ||
    finding.lineNumber === undefined ||
    !Number.isSafeInteger(finding.lineNumber)
  )
    return undefined;
  return {
    path,
    start_line: finding.lineNumber,
    end_line: finding.lineNumber,
    annotation_level:
      finding.severity === "BLOCKER" || finding.severity === "HIGH"
        ? "failure"
        : finding.severity === "MEDIUM"
          ? "warning"
          : "notice",
    message: bounded(`${finding.title}\n\n${finding.description}`, 4000),
  };
}

/** Pure presentation only: the caller owns verdict evaluation and API publication.
 * Text is bounded to 60,000 UTF-8 bytes, with complete table rows and omission counts.
 * Annotations retain only recorded valid file/line coordinates, in batches of 50.
 */
export function formatChecksReport(
  snapshot: ReviewSnapshot,
  options: ChecksReportOptions,
): ChecksReport {
  const input = ReviewSnapshotSchema.parse(snapshot);
  const settings = OptionsSchema.parse(options);
  const reviewers = Object.entries(input.reviewers).sort(([a], [b]) => compare(a, b));
  const findings = reviewers
    .flatMap(([, reviewer]) => reviewer.findings.filter((finding) => !finding.isResolved))
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  let text = `# Merge Verdict: ${settings.verdict}\n\nRepository: ${cell(input.repository)} PR #${input.pullRequestNumber}\n\nHead: ${cell(input.headSha)}\n\nState fingerprint: ${cell(input.stateFingerprint)}\n\nEvaluated at: ${settings.evaluatedAt}\n\n`;
  // Reserve enough space for all later section headers and three omission notices.
  const rowBudget = 58000;
  function section(
    title: string,
    headers: readonly string[],
    rows: readonly ReportCell[][],
    empty: string,
    label: string,
  ): void {
    text += `## ${title}\n\n`;
    if (rows.length === 0) {
      text += `${empty}.\n\n`;
      return;
    }
    text += row(headers) + row(headers.map(() => "---"));
    let omitted = 0;
    for (const values of rows) {
      const rendered = row(values);
      if (Buffer.byteLength(text + rendered, "utf8") > rowBudget) omitted++;
      else text += rendered;
    }
    text += `\n${omitted} ${label} rows omitted. Long cells are truncated at 1,000 UTF-8 bytes.\n\n`;
  }
  section(
    "Reviewer completion",
    ["Reviewer", "Evaluated SHA", "Status", "Freshness"],
    reviewers.map(([id, reviewer]) => [
      id,
      reviewer.evaluatedCommitSha ?? "unknown",
      reviewer.status,
      reviewer.isFresh && reviewer.evaluatedCommitSha === input.headSha ? "fresh" : "stale",
    ]),
    "No reviewer records",
    "reviewer",
  );
  const requiredChecks = [...new Set(settings.requiredChecks)].sort(compare);
  section(
    "Required checks",
    ["Check", "Status", "Conclusion", "Commit SHA", "Freshness"],
    requiredChecks.map((name) => {
      const check = Object.hasOwn(input.checkRuns, name) ? input.checkRuns[name] : undefined;
      return check === undefined
        ? [name, "MISSING", "unknown", "unknown", "unknown"]
        : [
            name,
            check.status,
            check.conclusion ?? "pending",
            check.commitSha,
            check.commitSha === input.headSha ? "fresh" : "stale",
          ];
    }),
    "No required checks configured",
    "check",
  );
  section(
    "Unresolved findings",
    ["Reviewer", "Severity", "Finding", "Location", "Description", "Source"],
    findings.map((finding) => [
      finding.reviewerId,
      finding.severity,
      finding.title,
      finding.filePath === undefined
        ? "general"
        : `${finding.filePath}${finding.lineNumber === undefined ? "" : `:${finding.lineNumber}`}`,
      finding.description,
      source(finding.rawCommentUrl),
    ]),
    "No unresolved findings",
    "finding",
  );
  const annotations = findings.flatMap((finding) => {
    const value = annotation(finding);
    return value === undefined ? [] : [value];
  });
  const annotationBatches: CheckAnnotation[][] = [];
  for (let start = 0; start < annotations.length; start += 50)
    annotationBatches.push(annotations.slice(start, start + 50));
  return {
    output: {
      title: `Merge Verdict: ${settings.verdict}`,
      summary: `${settings.verdict}: ${reviewers.length} reviewer records, ${requiredChecks.length} required checks, ${findings.length} unresolved findings. Evaluated ${settings.evaluatedAt}.`,
      text,
    },
    annotationBatches,
  };
}
