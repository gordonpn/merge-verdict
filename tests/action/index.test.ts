import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendStepSummary,
  extractPullRequestNumber,
  getActionInput,
  isSelfTriggeredEvent,
  loadEventPayload,
  type PullRequestCollector,
  parseBooleanInput,
  parseRepository,
  runAction,
  shouldAutoRun,
  writeActionOutput,
} from "../../src/action/index.js";
import type { GitHubPullRequestData } from "../../src/collector/github-collector.js";
import { VERSION } from "../../src/index.js";

function createPullRequestFixture(
  overrides: Partial<GitHubPullRequestData> = {},
): GitHubPullRequestData {
  const headSha = overrides.headSha ?? "fae800c4bf2c14072460e4b2a1790f29c96385a9";
  const baseSha = overrides.baseSha ?? "abce24b54d40470d402f8052c31c5a2f0e0dc0a8";
  return {
    repository: "gordonpn/merge-verdict",
    pullRequestNumber: 42,
    headSha,
    baseSha,
    headRef: "feat/action",
    baseRef: "main",
    isFork: false,
    isDraft: false,
    mergeable: true,
    authorLogin: "octocat",
    evaluationSha: headSha,
    policyVersion: baseSha,
    changedFilePaths: ["docs/guide.md"],
    reviewThreads: [],
    conversationComments: [],
    reviews: [],
    checkRuns: [
      {
        id: 101,
        name: "ci / test",
        status: "completed",
        conclusion: "success",
        commitSha: headSha,
        detailsUrl: "https://github.com/gordonpn/merge-verdict/runs/101",
        output: {
          title: "Passed",
          summary: "All tests passed",
          text: null,
        },
        startedAt: "2026-11-14T12:00:00Z",
        completedAt: "2026-11-14T12:01:00Z",
      },
    ],
    commitStatuses: [],
    policyContent: [
      "required_checks:",
      "  - ci / test",
      "approval:",
      "  required_check: merge-verdict",
      "  risk:",
      "    low:",
      "      paths:",
      '        - "docs/**"',
      "      automated_approval: allowed",
      "      require_human_review: false",
      "      effort: lite",
    ].join("\n"),
    ...overrides,
  };
}

function parseGitHubOutputFile(content: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = content.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const markerIndex = line.indexOf("<<");
    if (markerIndex === -1) {
      index += 1;
      continue;
    }
    const name = line.slice(0, markerIndex);
    const delimiter = line.slice(markerIndex + 2);
    const collected: string[] = [];
    index += 1;
    while (index < lines.length && lines[index] !== delimiter) {
      collected.push(lines[index] ?? "");
      index += 1;
    }
    outputs[name] = collected.join("\n");
    index += 1;
  }
  return outputs;
}

describe("GitHub Action environment and input helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "merge-verdict-action-test-"));
  });

  afterEach(() => {
    process.exitCode = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads hyphenated and underscored action inputs", () => {
    expect(
      getActionInput("github-token", {
        "INPUT_GITHUB-TOKEN": "  tok_hyphen  ",
      }),
    ).toBe("tok_hyphen");

    expect(
      getActionInput("github-token", {
        INPUT_GITHUB_TOKEN: "  tok_underscore  ",
      }),
    ).toBe("tok_underscore");

    expect(getActionInput("missing-input", {})).toBe("");
  });

  it("parses boolean inputs and rejects invalid strings", () => {
    expect(parseBooleanInput(undefined, false)).toBe(false);
    expect(parseBooleanInput("", true)).toBe(true);
    expect(parseBooleanInput("true")).toBe(true);
    expect(parseBooleanInput("TRUE")).toBe(true);
    expect(parseBooleanInput("1")).toBe(true);
    expect(parseBooleanInput("yes")).toBe(true);
    expect(parseBooleanInput("false")).toBe(false);
    expect(parseBooleanInput("0")).toBe(false);
    expect(parseBooleanInput("no")).toBe(false);
    expect(() => parseBooleanInput("maybe")).toThrow(TypeError);
  });

  it("writes multiline outputs to GITHUB_OUTPUT and summaries to GITHUB_STEP_SUMMARY", () => {
    const outputFile = join(tempDir, "github_output.txt");
    const summaryFile = join(tempDir, "step_summary.md");
    const env: NodeJS.ProcessEnv = {
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    };

    writeActionOutput("verdict", "PASS", env);
    writeActionOutput("summary", "Line 1\nLine 2", env);
    appendStepSummary("# Heading\n\nBody text", env);

    const parsedOutputs = parseGitHubOutputFile(readFileSync(outputFile, "utf8"));
    expect(parsedOutputs).toEqual({
      verdict: "PASS",
      summary: "Line 1\nLine 2",
    });

    const summaryContent = readFileSync(summaryFile, "utf8");
    expect(summaryContent).toBe("# Heading\n\nBody text\n");
  });

  it("loads valid JSON event payloads and throws on invalid JSON roots", () => {
    expect(loadEventPayload(undefined)).toBeNull();

    const validPath = join(tempDir, "event.json");
    writeFileSync(validPath, JSON.stringify({ pull_request: { number: 15 } }), "utf8");
    expect(loadEventPayload(validPath)).toEqual({ pull_request: { number: 15 } });

    const arrayPath = join(tempDir, "array.json");
    writeFileSync(arrayPath, JSON.stringify([1, 2, 3]), "utf8");
    expect(() => loadEventPayload(arrayPath)).toThrow(TypeError);
  });

  it("guards automatic module execution in tests and non-Actions environments", () => {
    expect(shouldAutoRun({ GITHUB_ACTIONS: "true", VITEST: "true" })).toBe(false);
    expect(shouldAutoRun({ GITHUB_ACTIONS: "true", NODE_ENV: "test" })).toBe(false);
    expect(
      shouldAutoRun({
        GITHUB_ACTIONS: "true",
        MERGE_VERDICT_DISABLE_AUTORUN: "true",
      }),
    ).toBe(false);
    expect(shouldAutoRun({ GITHUB_ACTIONS: "false" })).toBe(false);
    expect(shouldAutoRun({ GITHUB_ACTIONS: "true", NODE_ENV: "production" })).toBe(true);
    expect(shouldAutoRun({ MERGE_VERDICT_FORCE_AUTORUN: "true" })).toBe(true);
  });
});

describe("repository and pull request number extraction", () => {
  it("parses valid owner/repo coordinates and rejects invalid values", () => {
    expect(parseRepository("gordonpn/merge-verdict")).toEqual({
      owner: "gordonpn",
      repo: "merge-verdict",
      fullName: "gordonpn/merge-verdict",
    });
    expect(
      parseRepository(undefined, {
        repository: { full_name: "octo-org/octo.repo_1" },
      }),
    ).toEqual({
      owner: "octo-org",
      repo: "octo.repo_1",
      fullName: "octo-org/octo.repo_1",
    });
    expect(parseRepository("")).toBeNull();
    expect(parseRepository("only-owner")).toBeNull();
    expect(parseRepository("a/b/c")).toBeNull();
    expect(parseRepository("../repo")).toBeNull();
    expect(parseRepository("owner/..")).toBeNull();
  });

  it("extracts pull request numbers across workflow_dispatch, pull_request, issue_comment, and repository_dispatch", () => {
    expect(extractPullRequestNumber("42", { pull_request: { number: 99 } })).toBe(42);
    expect(extractPullRequestNumber("invalid", { pull_request: { number: 99 } })).toBeNull();

    expect(
      extractPullRequestNumber(undefined, {
        inputs: { pull_request_number: "17" },
      }),
    ).toBe(17);

    expect(
      extractPullRequestNumber(undefined, {
        inputs: { pr_number: 23 },
      }),
    ).toBe(23);

    expect(
      extractPullRequestNumber(undefined, {
        client_payload: { pr_number: "31" },
      }),
    ).toBe(31);

    expect(
      extractPullRequestNumber(undefined, {
        pull_request: { number: 58 },
      }),
    ).toBe(58);

    expect(
      extractPullRequestNumber(undefined, {
        issue: { number: 64, pull_request: { url: "https://api.github.com/pulls/64" } },
      }),
    ).toBe(64);

    expect(
      extractPullRequestNumber(undefined, {
        issue: { number: 64 },
      }),
    ).toBeNull();

    expect(
      extractPullRequestNumber(undefined, {
        check_run: { pull_requests: [{ number: 77 }] },
      }),
    ).toBe(77);

    expect(extractPullRequestNumber("0", {})).toBeNull();
    expect(extractPullRequestNumber("-5", {})).toBeNull();
  });
});

describe("isSelfTriggeredEvent loop prevention", () => {
  it.each(["merge-verdict[bot]", "github-actions[bot]"])(
    "skips events triggered by %s",
    (botActor) => {
      const result = isSelfTriggeredEvent({
        eventName: "pull_request",
        actor: botActor,
        payload: { pull_request: { number: 12 } },
      });
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain(botActor);
    },
  );

  it("skips pull_request_review events authored by Merge Verdict or GitHub Actions bots", () => {
    const result = isSelfTriggeredEvent({
      eventName: "pull_request_review",
      actor: "octocat",
      payload: {
        review: { user: { login: "merge-verdict[bot]" } },
      },
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("merge-verdict[bot]");
  });

  it("skips issue_comment events authored by Merge Verdict or GitHub Actions bots", () => {
    const result = isSelfTriggeredEvent({
      eventName: "issue_comment",
      actor: "octocat",
      payload: {
        comment: { user: { login: "github-actions[bot]" } },
      },
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("github-actions[bot]");
  });

  it("skips check_run events for the merge-verdict check run", () => {
    const result = isSelfTriggeredEvent({
      eventName: "check_run",
      actor: "octocat",
      payload: {
        check_run: { name: "merge-verdict" },
      },
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("merge-verdict");
  });

  it("allows human-triggered workflow_dispatch and third-party check_run events", () => {
    expect(
      isSelfTriggeredEvent({
        eventName: "workflow_dispatch",
        actor: "gordonpn",
        payload: { inputs: { pull_request_number: "13" } },
      }),
    ).toEqual({ skipped: false, reason: null });

    expect(
      isSelfTriggeredEvent({
        eventName: "check_run",
        actor: "coderabbitai[bot]",
        payload: { check_run: { name: "CodeRabbit" } },
      }),
    ).toEqual({ skipped: false, reason: null });
  });
});

describe("runAction end-to-end orchestration", () => {
  let tempDir: string;
  let outputFile: string;
  let summaryFile: string;
  let eventFile: string;
  const fixedNow = () => new Date("2026-11-14T16:00:00.000Z");

  beforeEach(() => {
    process.exitCode = 0;
    tempDir = mkdtempSync(join(tmpdir(), "merge-verdict-run-action-"));
    outputFile = join(tempDir, "github_output.txt");
    summaryFile = join(tempDir, "step_summary.md");
    eventFile = join(tempDir, "event.json");
    writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 42 } }), "utf8");
  });

  afterEach(() => {
    process.exitCode = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      GITHUB_REPOSITORY: "gordonpn/merge-verdict",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_ACTOR: "octocat",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      "INPUT_GITHUB-TOKEN": "test-token",
      ...overrides,
    };
  }

  it("terminates with exit code 0 and SKIPPED_SELF_EVENT when self-triggered", async () => {
    const collectPullRequest = vi.fn();
    const collector: PullRequestCollector = { collectPullRequest };

    const result = await runAction({
      env: baseEnv({ GITHUB_ACTOR: "merge-verdict[bot]" }),
      collector,
      now: fixedNow,
    });

    expect(result.verdict).toBe("SKIPPED_SELF_EVENT");
    expect(result.skipped).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(collectPullRequest).not.toHaveBeenCalled();

    const outputs = parseGitHubOutputFile(readFileSync(outputFile, "utf8"));
    expect(outputs.verdict).toBe("SKIPPED_SELF_EVENT");
    expect(outputs.summary).toContain("merge-verdict[bot]");
    expect(readFileSync(summaryFile, "utf8")).toContain("SKIPPED_SELF_EVENT");
  });

  it("evaluates a passing pull request and writes PASS outputs and step summary metadata", async () => {
    const fixture = createPullRequestFixture();
    const collectPullRequest = vi.fn().mockResolvedValue(fixture);
    const collector: PullRequestCollector = { collectPullRequest };

    const result = await runAction({
      env: baseEnv(),
      collector,
      now: fixedNow,
    });

    expect(result.verdict).toBe("PASS");
    expect(result.exitCode).toBe(0);
    expect(result.headSha).toBe(fixture.headSha);
    expect(result.riskTier?.tier).toBe("low");
    expect(result.riskTier?.canAutoApprove).toBe(true);
    expect(collectPullRequest).toHaveBeenCalledTimes(2);

    const outputs = parseGitHubOutputFile(readFileSync(outputFile, "utf8"));
    expect(outputs.verdict).toBe("PASS");
    expect(outputs.summary).toContain("PASS:");

    const stepSummary = readFileSync(summaryFile, "utf8");
    expect(stepSummary).toContain("# Merge Verdict: PASS");
    expect(stepSummary).toContain(`Engine version: \`${VERSION}\``);
    expect(stepSummary).toContain(`Evaluated head SHA: \`${fixture.headSha}\``);
    expect(stepSummary).toContain("Path risk tier: `low`");
    expect(stepSummary).toContain("All 8 policy conditions were satisfied.");
  });

  it("returns PENDING with exit code 0 when a required CI check is still in progress", async () => {
    const fixture = createPullRequestFixture({
      checkRuns: [
        {
          id: 102,
          name: "ci / test",
          status: "in_progress",
          conclusion: null,
          commitSha: "fae800c4bf2c14072460e4b2a1790f29c96385a9",
          detailsUrl: "https://github.com/gordonpn/merge-verdict/runs/102",
          output: { title: "Running", summary: null, text: null },
          startedAt: "2026-11-14T12:00:00Z",
          completedAt: null,
        },
      ],
    });
    const collector: PullRequestCollector = {
      collectPullRequest: vi.fn().mockResolvedValue(fixture),
    };

    const result = await runAction({
      env: baseEnv({ "INPUT_FAIL-FAST": "true" }),
      collector,
      now: fixedNow,
    });

    expect(result.verdict).toBe("PENDING");
    expect(result.exitCode).toBe(0);
    expect(result.evaluation?.reasons).toEqual([
      expect.objectContaining({
        condition: 1,
        outcome: "PENDING",
        code: "CHECK_INCOMPLETE",
        subject: "ci / test",
      }),
    ]);
  });

  it("returns FAIL when a required check fails and respects fail-fast", async () => {
    const fixture = createPullRequestFixture({
      checkRuns: [
        {
          id: 103,
          name: "ci / test",
          status: "completed",
          conclusion: "failure",
          commitSha: "fae800c4bf2c14072460e4b2a1790f29c96385a9",
          detailsUrl: "https://github.com/gordonpn/merge-verdict/runs/103",
          output: { title: "Failed", summary: "1 test failed", text: null },
          startedAt: "2026-11-14T12:00:00Z",
          completedAt: "2026-11-14T12:02:00Z",
        },
      ],
    });
    const collector: PullRequestCollector = {
      collectPullRequest: vi.fn().mockResolvedValue(fixture),
    };

    const nonBlockingRun = await runAction({
      env: baseEnv({ "INPUT_FAIL-FAST": "false" }),
      collector,
      now: fixedNow,
    });
    expect(nonBlockingRun.verdict).toBe("FAIL");
    expect(nonBlockingRun.exitCode).toBe(0);

    const failFastRun = await runAction({
      env: baseEnv({ "INPUT_FAIL-FAST": "true" }),
      collector,
      now: fixedNow,
    });
    expect(failFastRun.verdict).toBe("FAIL");
    expect(failFastRun.exitCode).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it("returns STALE when the final snapshot head SHA mutates during evaluation", async () => {
    const initialFixture = createPullRequestFixture();
    const mutatedFixture = createPullRequestFixture({
      headSha: "1111111111111111111111111111111111111111",
      evaluationSha: "1111111111111111111111111111111111111111",
    });
    const collector: PullRequestCollector = {
      collectPullRequest: vi
        .fn()
        .mockResolvedValueOnce(initialFixture)
        .mockResolvedValueOnce(mutatedFixture),
    };

    const result = await runAction({
      env: baseEnv({ "INPUT_FAIL-FAST": "true" }),
      collector,
      now: fixedNow,
    });

    expect(result.verdict).toBe("STALE");
    expect(result.exitCode).toBe(1);
    expect(result.evaluation?.reasons).toContainEqual(
      expect.objectContaining({
        condition: 6,
        outcome: "STALE",
        code: "SNAPSHOT_CHANGED",
      }),
    );
    expect(readFileSync(summaryFile, "utf8")).toContain("SNAPSHOT_CHANGED");
  });

  it("handles pre-snapshot collector or policy errors with a bounded ERROR report", async () => {
    const collector: PullRequestCollector = {
      collectPullRequest: vi.fn().mockRejectedValue(new Error("GitHub API rate limit exceeded")),
    };

    const result = await runAction({
      env: baseEnv(),
      collector,
      now: fixedNow,
    });

    expect(result.verdict).toBe("ERROR");
    expect(result.exitCode).toBe(1);
    expect(result.snapshot).toBeNull();

    const outputs = parseGitHubOutputFile(readFileSync(outputFile, "utf8"));
    expect(outputs.verdict).toBe("ERROR");
    expect(outputs.summary).toContain("GitHub API rate limit exceeded");

    const stepSummary = readFileSync(summaryFile, "utf8");
    expect(stepSummary).toContain("# Merge Verdict: ERROR");
    expect(stepSummary).toContain("GitHub API rate limit exceeded");
  });

  it("records Condition 7 EXECUTION_ERROR when final snapshot re-collection fails", async () => {
    const initialFixture = createPullRequestFixture();
    const collector: PullRequestCollector = {
      collectPullRequest: vi
        .fn()
        .mockResolvedValueOnce(initialFixture)
        .mockRejectedValueOnce(new Error("Transient network reset during revalidation")),
    };

    const result = await runAction({
      env: baseEnv({ "INPUT_FAIL-FAST": "true" }),
      collector,
      now: fixedNow,
    });

    expect(result.verdict).toBe("ERROR");
    expect(result.exitCode).toBe(1);
    expect(result.snapshot).not.toBeNull();
    expect(result.evaluation?.reasons).toContainEqual(
      expect.objectContaining({
        condition: 7,
        outcome: "ERROR",
        code: "EXECUTION_ERROR",
      }),
    );
  });

  it("writes a job-summary-only failure when repository or pull request number is missing", async () => {
    writeFileSync(eventFile, JSON.stringify({}), "utf8");
    const collectPullRequest = vi.fn();
    const collector: PullRequestCollector = { collectPullRequest };

    const result = await runAction({
      env: baseEnv({ GITHUB_REPOSITORY: "" }),
      collector,
      now: fixedNow,
    });

    expect(result.verdict).toBe("ERROR");
    expect(result.exitCode).toBe(1);
    expect(collectPullRequest).not.toHaveBeenCalled();

    const stepSummary = readFileSync(summaryFile, "utf8");
    expect(stepSummary).toContain(
      "No GitHub check run was created because the target repository or pull request number could not be resolved.",
    );
  });

  it("enforces issue link rules when requireIssueLink is enabled", async () => {
    const fixture = createPullRequestFixture();
    const collector: PullRequestCollector = {
      collectPullRequest: vi.fn().mockResolvedValue(fixture),
    };

    const missingIssueRun = await runAction({
      env: baseEnv(),
      collector,
      now: fixedNow,
      requireIssueLink: true,
      pullRequestBody: "No ticket reference here.",
    });
    expect(missingIssueRun.verdict).toBe("FAIL");
    expect(missingIssueRun.evaluation?.reasons).toContainEqual(
      expect.objectContaining({
        condition: 8,
        outcome: "FAIL",
        code: "REPOSITORY_RULE_UNSATISFIED",
        subject: "issue-links",
      }),
    );

    const linkedIssueRun = await runAction({
      env: baseEnv(),
      collector,
      now: fixedNow,
      requireIssueLink: true,
      pullRequestBody: "Closes #13",
    });
    expect(linkedIssueRun.verdict).toBe("PASS");
  });
});
