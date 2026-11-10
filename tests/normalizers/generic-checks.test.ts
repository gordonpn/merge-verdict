import { describe, expect, it } from "vitest";
import type { GitHubCheckRun, GitHubCommitStatus } from "../../src/collector/github-collector.js";
import { CheckRunRecordSchema } from "../../src/models/check-run.js";
import { normalizeCheckRuns } from "../../src/normalizers/generic-checks.js";

describe("normalizeCheckRuns", () => {
  it("normalizes completed check runs with valid URL", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 101,
        name: "runner / test",
        status: "completed",
        conclusion: "success",
        commitSha: "head123",
        detailsUrl: "https://github.com/org/repo/actions/runs/101",
        output: { title: null, summary: null, text: null },
        startedAt: "2026-10-01T10:00:00Z",
        completedAt: "2026-10-01T10:05:00Z",
      },
    ];

    const result = normalizeCheckRuns(checkRuns);
    expect(result["runner / test"]).toEqual({
      name: "runner / test",
      status: "completed",
      conclusion: "success",
      commitSha: "head123",
      detailsUrl: "https://github.com/org/repo/actions/runs/101",
    });
    expect(CheckRunRecordSchema.safeParse(result["runner / test"]).success).toBe(true);
  });

  it("omits invalid detailsUrl strings", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 102,
        name: "lint",
        status: "in_progress",
        conclusion: null,
        commitSha: "head123",
        detailsUrl: "not-a-valid-url",
        output: { title: null, summary: null, text: null },
        startedAt: "2026-10-01T10:00:00Z",
        completedAt: null,
      },
    ];

    const result = normalizeCheckRuns(checkRuns);
    expect(result.lint).toEqual({
      name: "lint",
      status: "in_progress",
      conclusion: null,
      commitSha: "head123",
    });
    expect(CheckRunRecordSchema.safeParse(result.lint).success).toBe(true);
  });

  it("normalizes commit statuses as fallback when no matching check run exists", () => {
    const commitStatuses: GitHubCommitStatus[] = [
      {
        context: "continuous-integration/travis-ci",
        state: "success",
        commitSha: "head123",
        targetUrl: "https://ci.example.com/build/1",
        description: "Build succeeded",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:05:00Z",
      },
      {
        context: "security/snyk",
        state: "failure",
        commitSha: "head123",
        targetUrl: null,
        description: "Vulnerabilities found",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:05:00Z",
      },
      {
        context: "pending-check",
        state: "pending",
        commitSha: "head123",
        targetUrl: null,
        description: null,
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:05:00Z",
      },
      {
        context: "error-check",
        state: "error",
        commitSha: "head123",
        targetUrl: null,
        description: null,
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:05:00Z",
      },
    ];

    const result = normalizeCheckRuns([], commitStatuses);
    expect(result["continuous-integration/travis-ci"]).toEqual({
      name: "continuous-integration/travis-ci",
      status: "completed",
      conclusion: "success",
      commitSha: "head123",
      detailsUrl: "https://ci.example.com/build/1",
    });
    expect(result["security/snyk"]).toEqual({
      name: "security/snyk",
      status: "completed",
      conclusion: "failure",
      commitSha: "head123",
    });
    expect(result["pending-check"]).toEqual({
      name: "pending-check",
      status: "in_progress",
      conclusion: null,
      commitSha: "head123",
    });
    expect(result["error-check"]).toEqual({
      name: "error-check",
      status: "completed",
      conclusion: "failure",
      commitSha: "head123",
    });
  });

  it("prioritizes check runs over commit statuses with the same name", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 201,
        name: "test",
        status: "completed",
        conclusion: "success",
        commitSha: "head123",
        detailsUrl: "https://github.com/org/repo/runs/201",
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const commitStatuses: GitHubCommitStatus[] = [
      {
        context: "test",
        state: "pending",
        commitSha: "head123",
        targetUrl: null,
        description: null,
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-01T10:05:00Z",
      },
    ];

    const result = normalizeCheckRuns(checkRuns, commitStatuses);
    expect(result.test?.status).toBe("completed");
    expect(result.test?.conclusion).toBe("success");
  });

  it("maps unsupported check conclusions to failure and waiting status to in_progress", () => {
    const checkRuns: GitHubCheckRun[] = [
      {
        id: 202,
        name: "stale-check",
        status: "completed",
        conclusion: "stale" as unknown as GitHubCheckRun["conclusion"],
        commitSha: "head123",
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
      {
        id: 203,
        name: "waiting-check",
        status: "waiting",
        conclusion: null,
        commitSha: "head123",
        detailsUrl: null,
        output: { title: null, summary: null, text: null },
        startedAt: null,
        completedAt: null,
      },
    ];

    const result = normalizeCheckRuns(checkRuns);
    expect(result["stale-check"]?.status).toBe("completed");
    expect(result["stale-check"]?.conclusion).toBe("failure");
    expect(result["waiting-check"]?.status).toBe("in_progress");
    expect(result["waiting-check"]?.conclusion).toBeNull();
    expect(CheckRunRecordSchema.safeParse(result["stale-check"]).success).toBe(true);
    expect(CheckRunRecordSchema.safeParse(result["waiting-check"]).success).toBe(true);
  });
});
