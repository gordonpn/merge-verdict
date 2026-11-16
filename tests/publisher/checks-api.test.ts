import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { createReviewSnapshot, type NormalizedFinding } from "../../src/models/index.js";
import {
  type ChecksClient,
  createOctokitChecksClient,
  DEFAULT_CHECK_NAME,
  DEFAULT_OWNED_EXTERNAL_ID_PREFIX,
  type ExistingCheckRun,
  formatPreSnapshotErrorReport,
  mapVerdictToCheckState,
  type PublisherVerdict,
  publishCheckRun,
  publishErrorCheckRun,
} from "../../src/publisher/index.js";

const evaluatedAt = "2026-11-11T12:00:00.000Z";
const headSha = "abc123def456";

function makeFinding(overrides: Partial<NormalizedFinding> = {}): NormalizedFinding {
  return {
    id: "f1",
    reviewerId: "reviewer",
    title: "Fix issue",
    description: "Actionable details",
    severity: "HIGH",
    isBlocking: true,
    isResolved: false,
    filePath: "src/index.ts",
    lineNumber: 10,
    ...overrides,
  };
}

function makeSnapshot(findings: NormalizedFinding[] = []) {
  return createReviewSnapshot({
    repository: "owner/repo",
    pullRequestNumber: 42,
    headSha,
    baseSha: "base000",
    isDraft: false,
    capturedAt: evaluatedAt,
    reviewers: {
      reviewer: {
        reviewerId: "reviewer",
        reviewerName: "Reviewer",
        status: "COMPLETED",
        evaluatedCommitSha: headSha,
        isFresh: true,
        verdict: "COMMENTED",
        findings,
        checkRunConclusion: "success",
      },
    },
    checkRuns: {
      ci: { name: "ci", status: "completed", conclusion: "success", commitSha: headSha },
    },
    unresolvedThreadCount: findings.length,
    blockingDecisionCount: 0,
  });
}

function makeExistingRun(overrides: Partial<ExistingCheckRun> = {}): ExistingCheckRun {
  const id = overrides.id ?? 100;
  return {
    id,
    name: DEFAULT_CHECK_NAME,
    headSha,
    status: "completed",
    conclusion: "success",
    htmlUrl: `https://github.com/owner/repo/runs/${id}`,
    appId: 999,
    externalId: `${DEFAULT_OWNED_EXTERNAL_ID_PREFIX}${headSha}`,
    ...overrides,
  };
}

function makeClient(existingRuns: ExistingCheckRun[] = []): ChecksClient {
  return {
    getHeadSha: vi.fn(async () => headSha),
    listCheckRunsForRef: vi.fn(async () => existingRuns),
    createCheckRun: vi.fn(async (params) => ({
      id: 200,
      htmlUrl: "https://github.com/owner/repo/runs/200",
      status: params.status,
      conclusion: params.conclusion,
    })),
    updateCheckRun: vi.fn(async (params) => ({
      id: params.checkRunId,
      htmlUrl: `https://github.com/owner/repo/runs/${params.checkRunId}`,
      status: params.status ?? "completed",
      conclusion: params.conclusion ?? null,
    })),
    isOwnedCheckRun: vi.fn(
      (run) =>
        run.appId === 999 &&
        typeof run.externalId === "string" &&
        run.externalId.startsWith(DEFAULT_OWNED_EXTERNAL_ID_PREFIX),
    ),
  };
}

describe("mapVerdictToCheckState", () => {
  it.each([
    ["PASS", { status: "completed", conclusion: "success" }],
    ["PENDING", { status: "in_progress", conclusion: null }],
    ["FAIL", { status: "completed", conclusion: "failure" }],
    ["STALE", { status: "completed", conclusion: "action_required" }],
    ["ERROR", { status: "completed", conclusion: "failure" }],
  ] as const)("maps %s to %o without ever emitting neutral or skipped", (verdict, expected) => {
    const state = mapVerdictToCheckState(verdict);
    expect(state).toEqual(expected);
    expect(state.conclusion).not.toBe("neutral");
    expect(state.conclusion).not.toBe("skipped");
  });
});

describe("publishCheckRun", () => {
  it("creates a new check run when no owned check run exists on the head SHA", async () => {
    const client = makeClient();
    const snapshot = makeSnapshot();
    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint: async () => snapshot.stateFingerprint,
    });

    expect(result).toEqual({
      action: "created",
      verdict: "PASS",
      headSha,
      status: "completed",
      conclusion: "success",
      checkRunId: 200,
      htmlUrl: "https://github.com/owner/repo/runs/200",
    });
    expect(client.createCheckRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        name: "merge-verdict",
        headSha,
        status: "completed",
        conclusion: "success",
        externalId: `merge-verdict:${headSha}`,
        startedAt: evaluatedAt,
        completedAt: evaluatedAt,
      }),
    );
    expect(client.updateCheckRun).not.toHaveBeenCalled();
  });

  it("publishes PENDING as in_progress with null conclusion and no completedAt", async () => {
    const client = makeClient();
    const snapshot = makeSnapshot();
    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PENDING",
      evaluatedAt,
      requiredChecks: ["ci"],
    });

    expect(result).toEqual({
      action: "created",
      verdict: "PENDING",
      headSha,
      status: "in_progress",
      conclusion: null,
      checkRunId: 200,
      htmlUrl: "https://github.com/owner/repo/runs/200",
    });
    expect(client.createCheckRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ completedAt: expect.anything() }),
    );
  });

  it("updates the latest owned check run idempotently on repeat runs including PENDING", async () => {
    const olderOwned = makeExistingRun({ id: 100 });
    const latestOwned = makeExistingRun({ id: 150 });
    const client = makeClient([olderOwned, latestOwned]);
    const snapshot = makeSnapshot([makeFinding()]);

    const firstResult = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "FAIL",
      evaluatedAt,
      requiredChecks: ["ci"],
    });
    expect(firstResult).toEqual({
      action: "updated",
      verdict: "FAIL",
      headSha,
      status: "completed",
      conclusion: "failure",
      checkRunId: 150,
      htmlUrl: "https://github.com/owner/repo/runs/150",
    });
    expect(client.createCheckRun).not.toHaveBeenCalled();
    expect(client.updateCheckRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        checkRunId: 150,
        status: "completed",
        conclusion: "failure",
        completedAt: evaluatedAt,
      }),
    );

    const pendingResult = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PENDING",
      evaluatedAt,
      requiredChecks: ["ci"],
    });
    expect(pendingResult.status).toBe("in_progress");
    expect(pendingResult.conclusion).toBeNull();
  });

  it("ignores foreign check runs with the same name and creates an owned check run instead", async () => {
    const foreignRun = makeExistingRun({
      id: 99,
      appId: 12345,
      externalId: "foreign:abc",
    });
    const wrongNameRun = makeExistingRun({
      id: 101,
      name: "other-check",
    });
    const wrongShaRun = makeExistingRun({
      id: 102,
      headSha: "other-sha",
    });
    const client = makeClient([foreignRun, wrongNameRun, wrongShaRun]);

    const snapshot = makeSnapshot();
    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint: async () => snapshot.stateFingerprint,
    });

    expect(result.action).toBe("created");
    expect(result.checkRunId).toBe(200);
    expect(client.updateCheckRun).not.toHaveBeenCalled();
    expect(client.createCheckRun).toHaveBeenCalledOnce();
  });

  it("splits >50 annotations across initial create and subsequent updateCheckRun calls", async () => {
    const client = makeClient();
    const findings = Array.from({ length: 105 }, (_, i) =>
      makeFinding({ id: `f-${String(i).padStart(3, "0")}`, lineNumber: i + 1 }),
    );
    const snapshot = makeSnapshot(findings);

    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "FAIL",
      evaluatedAt,
      requiredChecks: ["ci"],
    });

    expect(result.action).toBe("created");
    expect(client.createCheckRun).toHaveBeenCalledOnce();
    const createCall = vi.mocked(client.createCheckRun).mock.calls[0]?.[0];
    expect(createCall?.output.annotations).toHaveLength(50);

    expect(client.updateCheckRun).toHaveBeenCalledTimes(2);
    const secondBatch = vi.mocked(client.updateCheckRun).mock.calls[0]?.[0];
    const thirdBatch = vi.mocked(client.updateCheckRun).mock.calls[1]?.[0];
    expect(secondBatch?.checkRunId).toBe(200);
    expect(secondBatch?.output.annotations).toHaveLength(50);
    expect(thirdBatch?.checkRunId).toBe(200);
    expect(thirdBatch?.output.annotations).toHaveLength(5);
  });

  it("overrides PASS to STALE when pre-flight head SHA has mutated", async () => {
    const client = makeClient();
    client.getHeadSha = vi.fn(async () => "new-head-sha");
    const getLatestStateFingerprint = vi.fn(async () => "unused");
    const snapshot = makeSnapshot();

    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint,
    });

    expect(result).toEqual({
      action: "created",
      verdict: "STALE",
      headSha,
      status: "completed",
      conclusion: "action_required",
      checkRunId: 200,
      htmlUrl: "https://github.com/owner/repo/runs/200",
    });
    expect(getLatestStateFingerprint).not.toHaveBeenCalled();
  });

  it("overrides PASS to STALE when pre-flight state fingerprint has mutated", async () => {
    const client = makeClient();
    const snapshot = makeSnapshot();
    const getLatestStateFingerprint = vi.fn(async () => "mutated-fingerprint");

    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint,
    });

    expect(result).toEqual({
      action: "created",
      verdict: "STALE",
      headSha,
      status: "completed",
      conclusion: "action_required",
      checkRunId: 200,
      htmlUrl: "https://github.com/owner/repo/runs/200",
    });
    expect(getLatestStateFingerprint).toHaveBeenCalledOnce();
  });

  it("preserves PASS when pre-flight head SHA and state fingerprint match snapshot", async () => {
    const client = makeClient();
    const snapshot = makeSnapshot();
    const getLatestStateFingerprint = vi.fn(async () => snapshot.stateFingerprint);

    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint,
    });

    expect(result.verdict).toBe("PASS");
    expect(result.conclusion).toBe("success");
  });

  it.each([
    { status: "in_progress" as const, conclusion: null },
    { status: "completed" as const, conclusion: "failure" },
    { status: "completed" as const, conclusion: "action_required" },
  ])(
    "skips writing STALE when latest owned check run is already $status ($conclusion)",
    async ({ status, conclusion }) => {
      const existing = makeExistingRun({ id: 300, status, conclusion });
      const client = makeClient([existing]);

      const result = await publishCheckRun(client, {
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        snapshot: makeSnapshot(),
        verdict: "STALE",
        evaluatedAt,
        requiredChecks: ["ci"],
      });

      expect(result).toEqual({
        action: "skipped_newer_owner",
        verdict: "STALE",
        headSha,
        status,
        conclusion,
        checkRunId: 300,
        htmlUrl: "https://github.com/owner/repo/runs/300",
      });
      expect(client.createCheckRun).not.toHaveBeenCalled();
      expect(client.updateCheckRun).not.toHaveBeenCalled();
    },
  );

  it("overwrites an existing owned success check run with STALE (action_required) so it cannot remain mergeable", async () => {
    const existingSuccess = makeExistingRun({
      id: 301,
      status: "completed",
      conclusion: "success",
    });
    const client = makeClient([existingSuccess]);
    client.getHeadSha = vi.fn(async () => "moved-head");

    const snapshot = makeSnapshot();
    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint: async () => snapshot.stateFingerprint,
    });

    expect(result).toEqual({
      action: "updated",
      verdict: "STALE",
      headSha,
      status: "completed",
      conclusion: "action_required",
      checkRunId: 301,
      htmlUrl: "https://github.com/owner/repo/runs/301",
    });
    expect(client.updateCheckRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        checkRunId: 301,
        status: "completed",
        conclusion: "action_required",
      }),
    );
  });

  it("fails closed to STALE when verdict is PASS without getLatestStateFingerprint", async () => {
    const existingSuccess = makeExistingRun({
      id: 302,
      status: "completed",
      conclusion: "success",
    });
    const client = makeClient([existingSuccess]);

    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot: makeSnapshot(),
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
    });

    expect(result.verdict).toBe("STALE");
    expect(result.conclusion).toBe("action_required");
    expect(client.updateCheckRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        checkRunId: 302,
        status: "completed",
        conclusion: "action_required",
      }),
    );
  });

  it("creates a fresh check run instead of appending annotations onto an annotated owned run", async () => {
    const annotatedRun = makeExistingRun({
      id: 305,
      status: "completed",
      conclusion: "failure",
      annotationsCount: 2,
    });
    const client = makeClient([annotatedRun]);
    const snapshot = makeSnapshot();

    const result = await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint: async () => snapshot.stateFingerprint,
    });

    expect(result).toEqual({
      action: "created",
      verdict: "PASS",
      headSha,
      status: "completed",
      conclusion: "success",
      checkRunId: 200,
      htmlUrl: "https://github.com/owner/repo/runs/200",
    });
    expect(client.createCheckRun).toHaveBeenCalledOnce();
    expect(client.updateCheckRun).not.toHaveBeenCalled();
  });

  it("uses custom client ownedExternalIdPrefix when creating check runs", async () => {
    const client = {
      ...makeClient(),
      ownedExternalIdPrefix: "custom-gate:",
    };
    const snapshot = makeSnapshot();

    await publishCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      snapshot,
      verdict: "PASS",
      evaluatedAt,
      requiredChecks: ["ci"],
      getLatestStateFingerprint: async () => snapshot.stateFingerprint,
    });

    expect(client.createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: `custom-gate:${headSha}`,
      }),
    );

    await publishErrorCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha,
      evaluatedAt,
      errorCode: "COLLECTION_FAILED",
      errorMessage: "boom",
    });

    expect(client.createCheckRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        externalId: `custom-gate:${headSha}`,
      }),
    );
  });
});

describe("formatPreSnapshotErrorReport and publishErrorCheckRun", () => {
  it("formats and bounds untrusted error details and escapes HTML/Markdown injection", () => {
    const hugeMessage = `<script>| ![img](x) \`code\`\n${"\u4e00".repeat(2000)}`;
    const report = formatPreSnapshotErrorReport({
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha,
      evaluatedAt,
      errorCode: "POLICY_INVALID",
      errorMessage: hugeMessage,
    });

    expect(report.title).toBe("Merge Verdict: ERROR");
    expect(report.summary).toContain("POLICY_INVALID");
    expect(report.text).toContain("&lt;script&gt;");
    expect(report.text).toContain("&#124;");
    expect(report.text).not.toContain("<script>");
    expect(report.text).not.toContain("\ufffd");
    expect(Buffer.byteLength(report.text, "utf8")).toBeLessThanOrEqual(60000);
  });

  it("Truncates oversized overall report text safely at UTF-8 code-point boundaries", () => {
    const report = formatPreSnapshotErrorReport({
      owner: "o".repeat(500),
      repo: "r".repeat(500),
      pullNumber: 42,
      headSha: "h".repeat(500),
      evaluatedAt,
      errorCode: "c".repeat(500),
      errorMessage: "m".repeat(5000),
    });
    expect(report.text).toContain("...");
    expect(Buffer.byteLength(report.text, "utf8")).toBeLessThanOrEqual(60000);
  });

  it("creates or updates an owned check run with failure conclusion on pre-snapshot error", async () => {
    const client = makeClient();
    const created = await publishErrorCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha,
      evaluatedAt,
      errorCode: "COLLECTOR_RATE_LIMIT",
      errorMessage: "Secondary rate limit exceeded",
    });

    expect(created).toEqual({
      action: "created",
      verdict: "ERROR",
      headSha,
      status: "completed",
      conclusion: "failure",
      checkRunId: 200,
      htmlUrl: "https://github.com/owner/repo/runs/200",
    });

    const clientWithOwned = makeClient([makeExistingRun({ id: 400 })]);
    const updated = await publishErrorCheckRun(clientWithOwned, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha,
      evaluatedAt,
      errorCode: "COLLECTOR_RATE_LIMIT",
      errorMessage: "Secondary rate limit exceeded",
      checkName: DEFAULT_CHECK_NAME,
    });
    expect(updated).toEqual({
      action: "updated",
      verdict: "ERROR",
      headSha,
      status: "completed",
      conclusion: "failure",
      checkRunId: 400,
      htmlUrl: "https://github.com/owner/repo/runs/400",
    });
  });

  it.each([true, false])(
    "blocks the evaluated SHA after head lookup failure, owned=%s",
    async (owned) => {
      const client = makeClient([makeExistingRun({ appId: owned ? 999 : 123 })]);
      client.getHeadSha = vi.fn().mockRejectedValue(new Error("lookup unavailable"));
      const result = await publishErrorCheckRun(client, {
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        headSha,
        evaluatedAt,
        errorCode: "API_ERROR",
        errorMessage: "collection failed",
      });
      expect(result).toMatchObject({
        verdict: "ERROR",
        headSha,
        conclusion: "failure",
        action: owned ? "updated" : "created",
      });
      expect(client.listCheckRunsForRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: headSha }),
      );
      expect(client.updateCheckRun).toHaveBeenCalledTimes(owned ? 1 : 0);
      expect(client.createCheckRun).toHaveBeenCalledTimes(owned ? 0 : 1);
    },
  );

  it("transitions pre-snapshot error to STALE when getHeadSha detects a head change and respects ownership guard", async () => {
    const client = makeClient([makeExistingRun({ id: 401, conclusion: "success" })]);
    client.getHeadSha = vi.fn(async () => "newer-head");

    const updatedStale = await publishErrorCheckRun(client, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha,
      evaluatedAt,
      errorCode: "API_ERROR",
      errorMessage: "Failed to collect threads",
    });
    expect(updatedStale).toEqual({
      action: "updated",
      verdict: "STALE",
      headSha,
      status: "completed",
      conclusion: "action_required",
      checkRunId: 401,
      htmlUrl: "https://github.com/owner/repo/runs/401",
    });

    const clientInProgress = makeClient([
      makeExistingRun({ id: 402, status: "in_progress", conclusion: null }),
    ]);
    clientInProgress.getHeadSha = vi.fn(async () => "newer-head");

    const skipped = await publishErrorCheckRun(clientInProgress, {
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha,
      evaluatedAt,
      errorCode: "API_ERROR",
      errorMessage: "Failed to collect threads",
    });
    expect(skipped).toEqual({
      action: "skipped_newer_owner",
      verdict: "STALE",
      headSha,
      status: "in_progress",
      conclusion: null,
      checkRunId: 402,
      htmlUrl: "https://github.com/owner/repo/runs/402",
    });
    expect(clientInProgress.updateCheckRun).not.toHaveBeenCalled();
  });
});

describe("createOctokitChecksClient", () => {
  function makeMockOctokit() {
    const pullsGet = vi.fn(async () => ({
      data: { head: { sha: headSha } },
    }));
    const listForRef = vi.fn(async () => ({
      data: {
        check_runs: [
          {
            id: 10,
            name: "merge-verdict",
            head_sha: headSha,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/owner/repo/runs/10",
            app: { id: 77 },
            external_id: `merge-verdict:${headSha}`,
          },
          {
            id: 11,
            name: "merge-verdict",
            head_sha: headSha,
            status: "in_progress",
            conclusion: null,
            html_url: null,
            app: null,
            external_id: null,
          },
        ],
      },
    }));
    const create = vi.fn(async () => ({
      data: {
        id: 20,
        html_url: "https://github.com/owner/repo/runs/20",
        status: "completed",
        conclusion: "success",
      },
    }));
    const update = vi.fn(async () => ({
      data: {
        id: 10,
        html_url: null,
        status: "in_progress",
        conclusion: null,
      },
    }));
    const octokit = {
      rest: {
        pulls: { get: pullsGet },
        checks: { listForRef, create, update },
      },
    } as unknown as Octokit;
    return { octokit, pullsGet, listForRef, create, update };
  }

  it("adapts pulls.get, checks.listForRef, checks.create, and checks.update", async () => {
    const { octokit, pullsGet, listForRef, create, update } = makeMockOctokit();
    const client = createOctokitChecksClient(octokit, { expectedAppId: 77 });

    expect(await client.getHeadSha({ owner: "o", repo: "r", pullNumber: 1 })).toBe(headSha);
    expect(pullsGet).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 1 });

    const runs = await client.listCheckRunsForRef({
      owner: "o",
      repo: "r",
      ref: headSha,
      checkName: "merge-verdict",
    });
    expect(listForRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: headSha,
      check_name: "merge-verdict",
      per_page: 100,
    });
    expect(runs).toHaveLength(2);
    expect(runs[1]?.htmlUrl).toBe("");

    const created = await client.createCheckRun({
      owner: "o",
      repo: "r",
      name: "merge-verdict",
      headSha,
      status: "completed",
      conclusion: "success",
      externalId: `merge-verdict:${headSha}`,
      startedAt: evaluatedAt,
      completedAt: evaluatedAt,
      output: {
        title: "Title",
        summary: "Summary",
        text: "Text",
        annotations: [
          {
            path: "src/a.ts",
            start_line: 1,
            end_line: 1,
            annotation_level: "failure",
            message: "msg",
          },
        ],
      },
    });
    expect(created.id).toBe(20);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "success",
        external_id: `merge-verdict:${headSha}`,
      }),
    );

    create.mockResolvedValueOnce({
      data: {
        id: 21,
        html_url: null as unknown as string,
        status: "in_progress",
        conclusion: null as unknown as string,
      },
    });
    const createdPending = await client.createCheckRun({
      owner: "o",
      repo: "r",
      name: "merge-verdict",
      headSha,
      status: "in_progress",
      conclusion: null,
      output: { title: "T", summary: "S", text: "X" },
    });
    expect(createdPending).toEqual({
      id: 21,
      htmlUrl: "",
      status: "in_progress",
      conclusion: null,
    });

    const updated = await client.updateCheckRun({
      owner: "o",
      repo: "r",
      checkRunId: 10,
      status: "completed",
      conclusion: "failure",
      completedAt: evaluatedAt,
      output: {
        title: "Title",
        summary: "Summary",
        text: "Text",
        annotations: [],
      },
    });
    expect(updated.htmlUrl).toBe("");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 10,
        status: "completed",
        conclusion: "failure",
        completed_at: evaluatedAt,
      }),
    );

    await client.updateCheckRun({
      owner: "o",
      repo: "r",
      checkRunId: 10,
      output: { title: "T", summary: "S", text: "X" },
    });
  });

  it("verifies ownership with and without expectedAppId and supports direct octokit without .rest", () => {
    const directOctokit = {
      pulls: { get: vi.fn() },
      checks: { listForRef: vi.fn(), create: vi.fn(), update: vi.fn() },
    } as unknown as Octokit;

    const withAppId = createOctokitChecksClient(directOctokit, {
      expectedAppId: 77,
      ownedExternalIdPrefix: "custom-gate:",
    });
    expect(withAppId.ownedExternalIdPrefix).toBe("custom-gate:");
    expect(
      withAppId.isOwnedCheckRun(
        makeExistingRun({ appId: 77, externalId: `custom-gate:${headSha}` }),
      ),
    ).toBe(true);
    expect(withAppId.isOwnedCheckRun(makeExistingRun({ appId: 77, externalId: null }))).toBe(true);
    expect(withAppId.isOwnedCheckRun(makeExistingRun({ appId: 77, externalId: "other:123" }))).toBe(
      false,
    );
    expect(
      withAppId.isOwnedCheckRun(
        makeExistingRun({ appId: 88, externalId: `merge-verdict:${headSha}` }),
      ),
    ).toBe(false);

    const withoutAppId = createOctokitChecksClient(directOctokit);
    expect(
      withoutAppId.isOwnedCheckRun(
        makeExistingRun({ appId: null, externalId: `merge-verdict:${headSha}` }),
      ),
    ).toBe(true);
    expect(withoutAppId.isOwnedCheckRun(makeExistingRun({ appId: 77, externalId: null }))).toBe(
      false,
    );

    const VerdictCheck: PublisherVerdict = "PASS";
    expect(VerdictCheck).toBe("PASS");
  });
});
