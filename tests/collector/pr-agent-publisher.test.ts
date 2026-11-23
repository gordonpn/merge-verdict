import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { publishGeneratedReview } from "../../scripts/publish-pr-agent-review.js";
import { digestCommentBody } from "../../src/collector/pr-agent-provenance.js";
import { normalizePrAgentReviewer } from "../../src/normalizers/pr-agent.js";

function context() {
  return {
    repository: "octocat/hello-world",
    pullRequestNumber: 1,
    headSha: "a".repeat(40),
    runId: 30,
    runAttempt: 2,
  };
}

function output(overrides: Readonly<Record<string, unknown>> = {}): string {
  const fixture: unknown = JSON.parse(
    readFileSync(new URL("../fixtures/pr-agent/generated-output.json", import.meta.url), "utf8"),
  );
  if (typeof fixture !== "object" || fixture === null) throw new Error("Invalid fixture");
  return JSON.stringify({
    ...fixture,
    ...overrides,
  });
}

describe("publishGeneratedReview", () => {
  it("attests only the exact body and ID returned by its posting operation", async () => {
    const post = vi.fn(async (body: string) => ({ id: 101, body }));

    const result = await publishGeneratedReview(output(), context(), post);

    expect(post).toHaveBeenCalledExactlyOnceWith(
      readFileSync(
        new URL("../fixtures/pr-agent/published-review.md", import.meta.url),
        "utf8",
      ).trimEnd(),
    );
    expect(result).toEqual({
      schema_version: 2,
      workflow_path: ".github/workflows/pr-agent.yml",
      run_id: 30,
      run_attempt: 2,
      repository: "octocat/hello-world",
      pull_request_number: 1,
      head_sha: context().headSha,
      comment_id: 101,
      body_digest: digestCommentBody(post.mock.calls[0]?.[0] ?? ""),
    });
  });

  it.each([
    "",
    "not-json",
    "null",
    "[]",
    output({ type: "describe" }),
    output({ markdown: "" }),
    output({ markdown: "   " }),
    output({ markdown: null }),
    output({ pr: null }),
    output({ pr: { provider: "gitlab" } }),
    output({
      pr: { provider: "github", repo: "other/repo", number: 1, head_sha: context().headSha },
    }),
    output({
      pr: {
        provider: "github",
        repo: context().repository,
        number: 2,
        head_sha: context().headSha,
      },
    }),
    output({
      pr: { provider: "github", repo: context().repository, number: 1, head_sha: "b".repeat(40) },
    }),
    `${output()}\n${output()}`,
  ])(
    "rejects invalid, ambiguous, or unrelated generated output before posting: %s",
    async (text) => {
      const post = vi.fn();

      await expect(publishGeneratedReview(text, context(), post)).rejects.toThrow();

      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each([null, {}, { id: 0 }, { id: 1.5 }, { id: 1, body: "sibling workflow replacement" }])(
    "rejects a missing or mismatched posting receipt: %s",
    async (receipt) => {
      await expect(
        publishGeneratedReview(output(), context(), async () => receipt),
      ).rejects.toThrow();
    },
  );

  it("propagates posting failure without manufacturing evidence", async () => {
    await expect(
      publishGeneratedReview(output(), context(), async () => {
        throw new Error("GitHub rejected the write");
      }),
    ).rejects.toThrow("GitHub rejected the write");
  });

  it.each([false, true])(
    "normalizes its posted review and rejects later edits: %s",
    async (edited) => {
      const post = vi.fn(async (body: string) => ({ id: 101, body }));
      const evidence = await publishGeneratedReview(output(), context(), post);
      const body = `${post.mock.calls[0]?.[0] ?? ""}${edited ? "edited" : ""}`;

      const result = normalizePrAgentReviewer({
        headSha: context().headSha,
        repository: context().repository,
        conversationComments: [
          {
            id: 101,
            authorLogin: "github-actions[bot]",
            body,
            bodyDigest: digestCommentBody(body),
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: null,
          },
        ],
        prAgentProvenance: {
          status: "verified",
          workflowPath: evidence.workflow_path,
          runId: evidence.run_id,
          headSha: evidence.head_sha,
          commentId: evidence.comment_id,
          bodyDigest: evidence.body_digest,
        },
      });

      expect(result).toMatchObject({
        status: edited ? "PENDING" : "COMPLETED",
        verdict: edited ? "NONE" : "APPROVE",
        isFresh: !edited,
      });
    },
  );

  it.each([true, false])(
    "preserves active findings and review completeness: %s",
    async (complete) => {
      const state = readFileSync(
        new URL("../fixtures/pr-agent/state.json", import.meta.url),
        "utf8",
      )
        .replace("1".repeat(40), context().headSha)
        .replace('"complete": true', `"complete": ${complete}`);
      const markdown = readFileSync(
        new URL("../fixtures/pr-agent/state-comment.md", import.meta.url),
        "utf8",
      ).replace("{{state}}", state);
      const post = vi.fn(async (body: string) => ({ id: 101, body }));
      const evidence = await publishGeneratedReview(output({ markdown }), context(), post);
      const body = post.mock.calls[0]?.[0] ?? "";

      const result = normalizePrAgentReviewer({
        headSha: context().headSha,
        repository: context().repository,
        conversationComments: [
          {
            id: 101,
            authorLogin: "github-actions[bot]",
            body,
            bodyDigest: digestCommentBody(body),
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: null,
          },
        ],
        prAgentProvenance: {
          status: "verified",
          workflowPath: evidence.workflow_path,
          runId: evidence.run_id,
          headSha: evidence.head_sha,
          commentId: evidence.comment_id,
          bodyDigest: evidence.body_digest,
        },
      });

      expect(result.status).toBe(complete ? "COMPLETED" : "PENDING");
      expect(result.verdict).toBe("CHANGES_REQUESTED");
      expect(result.findings).toEqual([
        expect.objectContaining({
          id: "pr-agent-finding-1",
          description: "Unresolved concern",
          isBlocking: true,
          isResolved: false,
          filePath: "src/file.ts",
          lineNumber: 4,
        }),
      ]);
    },
  );

  it.each([
    { overrides: {}, success: true },
    { overrides: { TEST_CURRENT_HEAD: "b".repeat(40) }, success: false },
    { overrides: { GITHUB_REPOSITORY: "" }, success: false },
    { overrides: { GITHUB_REPOSITORY: "invalid" }, success: false },
    { overrides: { HEAD_SHA: "invalid" }, success: false },
    { overrides: { PR_NUMBER: "0" }, success: false },
    { overrides: { GITHUB_RUN_ID: "not-a-number" }, success: false },
    { overrides: { GITHUB_RUN_ATTEMPT: "-1" }, success: false },
    { overrides: { PROVENANCE_PATH: "" }, success: false },
  ])(
    "validates CLI inputs and writes evidence only after publication: $overrides",
    ({ overrides, success }) => {
      const directory = mkdtempSync(join(tmpdir(), "pr-agent-publisher-"));
      const outputPath = join(directory, "output.jsonl");
      const provenancePath = join(directory, "provenance.json");
      symlinkSync(
        fileURLToPath(new URL("../fixtures/pr-agent/posting-gh.ts", import.meta.url)),
        join(directory, "gh"),
      );
      writeFileSync(outputPath, output());

      try {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(new URL("../../scripts/publish-pr-agent-review.ts", import.meta.url))],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
              GITHUB_REPOSITORY: context().repository,
              HEAD_SHA: context().headSha,
              PR_NUMBER: "1",
              GITHUB_RUN_ID: "30",
              GITHUB_RUN_ATTEMPT: "2",
              PR_AGENT_OUTPUT_PATH: outputPath,
              PROVENANCE_PATH: provenancePath,
              TEST_CURRENT_HEAD: context().headSha,
              ...overrides,
            },
          },
        );

        expect(result.status, result.stderr).toBe(success ? 0 : 1);
        expect(existsSync(provenancePath)).toBe(success);
        if (success) {
          const evidence: unknown = JSON.parse(readFileSync(provenancePath, "utf8"));
          expect(evidence).toMatchObject({
            comment_id: 101,
            head_sha: context().headSha,
            run_attempt: 2,
          });
        }
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
  );
});
