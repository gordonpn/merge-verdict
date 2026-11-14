import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateDiffCoverage,
  parseLcov,
  parseUnifiedDiff,
  runCli,
} from "../../scripts/check-diff-coverage.mjs";

describe("check-diff-coverage", () => {
  it("parses LCOV records and normalizes root and relative paths", () => {
    const lcov = [
      "TN:",
      "SF:/repo/src/policy/evaluator.ts",
      "DA:10,2",
      "DA:11,0",
      "end_of_record",
      "SF:./src/config/loader.ts",
      "DA:5,1",
      "end_of_record",
    ].join("\n");

    const map = parseLcov(lcov, "/repo");

    expect(map.get("src/policy/evaluator.ts")?.get(10)).toBe(2);
    expect(map.get("src/policy/evaluator.ts")?.get(11)).toBe(0);
    expect(map.get("src/config/loader.ts")?.get(5)).toBe(1);
  });

  it("parses unified git diff for tracked source paths only and ignores declarations", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "+++ b/README.md",
      "@@ -1,0 +2,3 @@",
      "diff --git a/src/collector/queries/graphql.d.ts b/src/collector/queries/graphql.d.ts",
      "+++ b/src/collector/queries/graphql.d.ts",
      "@@ -1,0 +1,2 @@",
      "diff --git a/src/policy/evaluator.ts b/src/policy/evaluator.ts",
      "+++ b/src/policy/evaluator.ts",
      "@@ -10,0 +12,2 @@",
      "@@ -30,1 +35 @@",
      "diff --git a/tests/policy/evaluator.test.ts b/tests/policy/evaluator.test.ts",
      "+++ b/tests/policy/evaluator.test.ts",
      "@@ -1,0 +1,5 @@",
    ].join("\n");

    const changed = parseUnifiedDiff(diff);

    expect(changed.has("README.md")).toBe(false);
    expect(changed.has("src/collector/queries/graphql.d.ts")).toBe(false);
    expect(changed.has("tests/policy/evaluator.test.ts")).toBe(false);
    expect(Array.from(changed.get("src/policy/evaluator.ts") ?? []).sort((a, b) => a - b)).toEqual([
      12, 13, 35,
    ]);
  });

  it("fails when uncovered diff lines drop below threshold", () => {
    const lcovMap = parseLcov(
      ["SF:src/a.ts", "DA:10,1", "DA:11,0", "DA:12,0", "end_of_record"].join("\n"),
      "/repo",
    );
    const diffMap = parseUnifiedDiff(["+++ b/src/a.ts", "@@ -9,0 +10,3 @@"].join("\n"));

    const result = evaluateDiffCoverage({ lcovMap, diffMap, threshold: 85 });

    expect(result.passed).toBe(false);
    expect(result.totalLines).toBe(3);
    expect(result.coveredLines).toBe(1);
    expect(result.uncoveredByFile).toEqual({ "src/a.ts": [11, 12] });
  });

  it("fails when a newly added source file is completely absent from LCOV", () => {
    const lcovMap = new Map();
    const diffMap = parseUnifiedDiff(["+++ b/src/new-module.ts", "@@ -0,0 +1,4 @@"].join("\n"));

    const result = evaluateDiffCoverage({ lcovMap, diffMap, threshold: 85 });

    expect(result.passed).toBe(false);
    expect(result.totalLines).toBe(4);
    expect(result.coveredLines).toBe(0);
    expect(result.uncoveredByFile).toEqual({
      "src/new-module.ts": [1, 2, 3, 4],
    });
  });

  it("passes when there are no tracked source changes or all changed lines are covered", () => {
    const emptyResult = evaluateDiffCoverage({
      lcovMap: new Map(),
      diffMap: new Map(),
      threshold: 85,
    });
    expect(emptyResult.passed).toBe(true);
    expect(emptyResult.percentage).toBe(100);

    const lcovMap = parseLcov(
      ["SF:src/a.ts", "DA:10,3", "DA:11,1", "end_of_record"].join("\n"),
      "/repo",
    );
    const diffMap = parseUnifiedDiff(["+++ b/src/a.ts", "@@ -9,0 +10,3 @@"].join("\n"));
    const coveredResult = evaluateDiffCoverage({ lcovMap, diffMap, threshold: 85 });
    expect(coveredResult.passed).toBe(true);
    expect(coveredResult.totalLines).toBe(2);
    expect(coveredResult.coveredLines).toBe(2);
  });

  it("runCli exits 1 when LCOV file is missing", () => {
    const errors: string[] = [];
    let exitCode: number | undefined;

    runCli({
      lcovPath: "/nonexistent/lcov.info",
      exit: (code) => {
        exitCode = code;
      },
      error: (msg) => errors.push(msg),
    });

    expect(exitCode).toBe(1);
    expect(errors.some((line) => line.includes("missing LCOV file"))).toBe(true);
  });

  it("runCli passes and fails based on diff coverage against LCOV file", () => {
    const dir = mkdtempSync(join(tmpdir(), "diff-cov-"));
    try {
      const lcovPath = join(dir, "lcov.info");
      writeFileSync(lcovPath, "SF:src/a.ts\nDA:10,1\nDA:11,0\nend_of_record\n", "utf8");

      const logs: string[] = [];
      const errors: string[] = [];
      let exitCode: number | undefined;

      runCli({
        lcovPath,
        threshold: 85,
        execDiff: () => "+++ b/src/a.ts\n@@ -9,0 +10,1 @@\n",
        exit: (code) => {
          exitCode = code;
        },
        log: (msg) => logs.push(msg),
        error: (msg) => errors.push(msg),
      });

      expect(exitCode).toBeUndefined();
      expect(logs.some((line) => line.includes("1/1 lines (100.00%"))).toBe(true);
      expect(errors).toEqual([]);

      runCli({
        lcovPath,
        threshold: 85,
        execDiff: () => "+++ b/src/a.ts\n@@ -9,0 +10,2 @@\n",
        exit: (code) => {
          exitCode = code;
        },
        log: (msg) => logs.push(msg),
        error: (msg) => errors.push(msg),
      });

      expect(exitCode).toBe(1);
      expect(errors.some((line) => line.includes("src/a.ts: 11"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
