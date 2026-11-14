import { describe, expect, it } from "vitest";
import { createReviewSnapshot, type NormalizedFinding } from "../../src/models/index.js";
import { formatChecksReport } from "../../src/publisher/checks-formatter.js";

const evaluatedAt = "2026-11-11T12:00:00.000Z";
function finding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    id: "f1",
    reviewerId: "reviewer",
    title: "Fix this",
    description: "Details",
    severity: "HIGH",
    isBlocking: true,
    isResolved: false,
    filePath: "src/file.ts",
    lineNumber: 3,
    ...overrides,
  };
}
function snapshot(findings: NormalizedFinding[] = []) {
  return createReviewSnapshot({
    repository: "owner/repo",
    pullRequestNumber: 1,
    headSha: "head",
    baseSha: "base",
    isDraft: false,
    capturedAt: evaluatedAt,
    reviewers: {
      reviewer: {
        reviewerId: "reviewer",
        reviewerName: "Reviewer",
        status: "COMPLETED",
        evaluatedCommitSha: "head",
        isFresh: true,
        verdict: "COMMENTED",
        findings,
        checkRunConclusion: "success",
      },
    },
    checkRuns: {
      test: { name: "test", status: "completed", conclusion: "success", commitSha: "head" },
    },
    unresolvedThreadCount: findings.length,
    blockingDecisionCount: 0,
  });
}
const options = { verdict: "FAIL" as const, evaluatedAt, requiredChecks: ["test", "missing"] };
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

describe("formatChecksReport", () => {
  it("renders verdict and audit metadata with reviewer, check and unresolved finding tables", () => {
    const input = snapshot([finding()]);
    const report = formatChecksReport(input, options);
    expect(report.output.title).toBe("Merge Verdict: FAIL");
    for (const text of [
      input.stateFingerprint,
      evaluatedAt,
      "Reviewer completion",
      "Required checks",
      "Unresolved findings",
      "Fix this",
      "missing",
      "MISSING",
    ])
      expect(report.output.text).toContain(text);
    expect(report.output.summary).toContain("1 unresolved findings");
  });
  it("does not present a stale check or reviewer as fresh despite stored isFresh", () => {
    const input = snapshot();
    required(input.reviewers.reviewer).evaluatedCommitSha = "old";
    required(input.checkRuns.test).commitSha = "old";
    const text = formatChecksReport(input, options).output.text;
    expect(text).toContain("old");
    expect(text.match(/stale/g)?.length).toBe(2);
  });
  it("escapes untrusted Markdown and HTML so a title cannot inject rows or images", () => {
    const text = formatChecksReport(
      snapshot([finding({ title: "<script>\n| ![x](url) `x` *x*" })]),
      options,
    ).output.text;
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("&#124;");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("![x]");
    expect(text).not.toContain("`x`");
  });
  it("excludes resolved findings from reports and annotations", () => {
    const report = formatChecksReport(
      snapshot([finding({ isResolved: true, title: "Already fixed" })]),
      options,
    );
    expect(report.output.text).not.toContain("Already fixed");
    expect(report.annotationBatches).toEqual([]);
  });
  it("batches 101 annotations into 50, 50 and 1", () => {
    const report = formatChecksReport(
      snapshot(Array.from({ length: 101 }, (_, i) => finding({ id: `f${i}` }))),
      options,
    );
    expect(report.annotationBatches.map((batch) => batch.length)).toEqual([50, 50, 1]);
    expect(report.annotationBatches[0]?.[0]).toMatchObject({
      path: "src/file.ts",
      start_line: 3,
      end_line: 3,
      annotation_level: "failure",
    });
  });
  it.each([undefined, "", "/tmp/file", "../file", "src/../file", "C:\\file", "src\\file"])(
    "does not invent annotations for invalid path %s",
    (filePath) => {
      const item = finding();
      if (filePath === undefined) delete item.filePath;
      else item.filePath = filePath;
      expect(formatChecksReport(snapshot([item]), options).annotationBatches).toEqual([]);
    },
  );
  it("keeps file-level and general findings visible without inventing line annotations", () => {
    const item = finding();
    delete item.lineNumber;
    const report = formatChecksReport(snapshot([item]), options);
    expect(report.output.text).toContain("Fix this");
    expect(report.annotationBatches).toEqual([]);
  });
  it.each([undefined, "src/file.ts"])(
    "retains actionable details without annotations at %s",
    (filePath) => {
      const item = finding({
        description: "Repair the missing guard",
        rawCommentUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
      });
      delete item.lineNumber;
      if (filePath === undefined) delete item.filePath;
      else item.filePath = filePath;
      const report = formatChecksReport(snapshot([item]), options);
      expect(report.output.text).toContain("Repair the missing guard");
      expect(report.output.text).toContain(
        "[Source](<https://github.com/owner/repo/pull/1#discussion_r1>)",
      );
      expect(report.annotationBatches).toEqual([]);
    },
  );
  it("escapes descriptions and source-link Markdown delimiters", () => {
    const text = formatChecksReport(
      snapshot([
        finding({
          description: "<img>\n| ![injected](bad) `code`",
          rawCommentUrl: "https://example.com/a)[injected](bad)|x",
        }),
      ]),
      options,
    ).output.text;
    expect(text).toContain("&lt;img&gt;<br>&#124; !&#91;injected&#93;(bad) &#96;code&#96;");
    expect(text).toContain("https://example.com/a%29%5Binjected%5D%28bad%29%7Cx");
    expect(text).not.toContain("![injected]");
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,bad",
    "https://user:secret@example.com/x",
    `https://example.com/${"x".repeat(2000)}`,
  ])("does not render unsafe or oversized source %s", (rawCommentUrl) => {
    const text = formatChecksReport(
      snapshot([finding({ rawCommentUrl, description: "Actionable" })]),
      options,
    ).output.text;
    expect(text).toContain("Actionable");
    expect(text).not.toContain("[Source]");
  });
  it("rejects malformed source URLs through snapshot validation", () => {
    expect(() =>
      formatChecksReport(snapshot([finding({ rawCommentUrl: "not a URL" })]), options),
    ).toThrow();
  });
  it("counts omitted oversized escaped rows exactly within the report budget", () => {
    const report = formatChecksReport(
      snapshot(
        Array.from({ length: 150 }, (_, i) =>
          finding({
            id: `f${i}`,
            title: "Title",
            description: "<|".repeat(70000),
            rawCommentUrl: "https://example.com/x",
          }),
        ),
      ),
      options,
    );
    const rendered = report.output.text
      .split("\n")
      .filter((line) => line.startsWith("| reviewer | HIGH | Title |")).length;
    expect(rendered).toBeGreaterThan(0);
    expect(report.output.text).toContain(`${150 - rendered} finding rows omitted`);
    expect(Buffer.byteLength(report.output.text)).toBeLessThanOrEqual(60000);
    expect(report.annotationBatches.map((batch) => batch.length)).toEqual([50, 50, 50]);
  });
  it("bounds multibyte report text and annotation messages while reporting omissions", () => {
    const huge = "\u4e00".repeat(70000);
    const report = formatChecksReport(
      snapshot(
        Array.from({ length: 150 }, (_, i) =>
          finding({ id: `f${i}`, title: huge, description: huge }),
        ),
      ),
      options,
    );
    expect(Buffer.byteLength(report.output.text, "utf8")).toBeLessThanOrEqual(60000);
    expect(report.output.text).toMatch(/\d+ finding rows omitted/);
    expect(report.output.text).not.toContain("\ufffd");
    expect(
      Buffer.byteLength(required(report.annotationBatches[0]?.[0]).message),
    ).toBeLessThanOrEqual(4000);
  });
  it("sorts evidence deterministically without mutating the snapshot", () => {
    const input = snapshot([finding({ id: "z" }), finding({ id: "a" })]);
    const original = structuredClone(input);
    const first = formatChecksReport(input, options);
    required(input.reviewers.reviewer).findings.reverse();
    expect(formatChecksReport(input, options)).toEqual(first);
    required(input.reviewers.reviewer).findings.reverse();
    expect(input).toEqual(original);
  });
  it("renders an empty evidence set explicitly", () => {
    const input = snapshot();
    input.reviewers = {};
    input.checkRuns = {};
    const report = formatChecksReport(input, {
      verdict: "PENDING",
      evaluatedAt,
      requiredChecks: [],
    });
    expect(report.output.text).toContain("No reviewer records");
    expect(report.output.text).toContain("No required checks configured");
    expect(report.output.text).toContain("No unresolved findings");
  });
  it("rejects arbitrarily long fractional timestamp metadata before rendering", () => {
    const evaluatedAt = `2026-11-11T12:00:00.${"1".repeat(70000)}Z`;
    expect(() => formatChecksReport(snapshot(), { ...options, evaluatedAt })).toThrow();
  });
  it.each(["toString", "constructor", "__proto__"])(
    "treats absent prototype-named check %s as missing",
    (name) => {
      const input = snapshot();
      input.checkRuns = {};
      expect(
        formatChecksReport(input, { ...options, requiredChecks: [name] }).output.text,
      ).toContain("MISSING");
    },
  );
});
