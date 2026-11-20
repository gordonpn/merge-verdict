import { describe, expect, it } from "vitest";
import type { GitHubCheckRun } from "../../src/collector/github-collector.js";
import { parseIsoTimestamp, rateLimitCheckTimestamp } from "../../src/normalizers/utils.js";

function makeCheckRun(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 1,
    name: "CodeRabbit",
    status: "completed",
    conclusion: "neutral",
    commitSha: "head-sha",
    detailsUrl: null,
    startedAt: "2026-11-19T12:00:00Z",
    completedAt: "2026-11-19T12:00:00Z",
    output: {
      title: "Review limit reached",
      summary: null,
      text: null,
    },
    ...overrides,
  };
}

describe("parseIsoTimestamp", () => {
  it("accepts valid UTC ISO datetimes and rejects invalid or empty values", () => {
    expect(parseIsoTimestamp("2026-11-19T12:00:00Z")).toBe("2026-11-19T12:00:00Z");
    expect(parseIsoTimestamp("not-a-timestamp")).toBeUndefined();
    expect(parseIsoTimestamp(null)).toBeUndefined();
    expect(parseIsoTimestamp(undefined)).toBeUndefined();
  });
});

describe("rateLimitCheckTimestamp", () => {
  const patterns = [/review limit/i] as const;

  it("returns undefined for missing, stale, or incomplete check runs", () => {
    expect(rateLimitCheckTimestamp(undefined, "head-sha", patterns)).toBeUndefined();
    expect(
      rateLimitCheckTimestamp(makeCheckRun({ commitSha: "old-sha" }), "head-sha", patterns),
    ).toBeUndefined();
    expect(
      rateLimitCheckTimestamp(makeCheckRun({ status: "in_progress" }), "head-sha", patterns),
    ).toBeUndefined();
  });

  it("returns completedAt only when output matches and completedAt is a valid UTC timestamp", () => {
    expect(rateLimitCheckTimestamp(makeCheckRun(), "head-sha", patterns)).toBe(
      "2026-11-19T12:00:00Z",
    );
    expect(
      rateLimitCheckTimestamp(
        makeCheckRun({ output: { title: "Completed", summary: null, text: null } }),
        "head-sha",
        patterns,
      ),
    ).toBeUndefined();
    expect(
      rateLimitCheckTimestamp(makeCheckRun({ completedAt: null }), "head-sha", patterns),
    ).toBeUndefined();
  });
});
