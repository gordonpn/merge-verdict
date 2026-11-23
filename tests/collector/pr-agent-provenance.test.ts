import { deflateRawSync } from "node:zlib";
import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import {
  collectPrAgentProvenance,
  digestCommentBody,
} from "../../src/collector/pr-agent-provenance.js";

function makeZip(entryName: string, body: string): ArrayBuffer {
  const content = Buffer.from(body, "utf8");
  const payload = deflateRawSync(content);
  const nameBytes = Buffer.from(entryName, "utf8");

  const localHeader = Buffer.alloc(30 + nameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(localHeader, 30);

  const centralHeader = Buffer.alloc(46 + nameBytes.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(centralHeader, 46);

  const endOfCentral = Buffer.alloc(22);
  endOfCentral.writeUInt32LE(0x06054b50, 0);
  endOfCentral.writeUInt16LE(1, 8);
  endOfCentral.writeUInt16LE(1, 10);
  endOfCentral.writeUInt32LE(centralHeader.length, 12);
  endOfCentral.writeUInt32LE(localHeader.length + payload.length, 16);

  const combined = Buffer.concat([localHeader, payload, centralHeader, endOfCentral]);
  return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
}

const directRetry = async <T>(_op: string, fn: () => Promise<T>): Promise<T> => fn();

describe("collectPrAgentProvenance", () => {
  const headSha = "a".repeat(40);

  it("returns unverified when artifacts are expired, unparseable, or fail schema validation", async () => {
    for (const scenario of [
      {
        artifacts: [{ id: 1, name: "pr-agent-review-provenance", expired: true }],
        archive: makeZip("pr-agent-provenance.json", "{}"),
      },
      {
        artifacts: [{ id: 1, name: "pr-agent-review-provenance", expired: false }],
        archive: makeZip("pr-agent-provenance.json", "{not-json"),
      },
      {
        artifacts: [{ id: 1, name: "pr-agent-review-provenance", expired: false }],
        archive: makeZip("pr-agent-provenance.json", '{"schema_version":1}'),
      },
      {
        artifacts: [{ id: 1, name: "pr-agent-review-provenance", expired: false }],
        archive: makeZip("wrong.json", "{}"),
      },
      {
        artifacts: [{ id: 1, name: "pr-agent-review-provenance", expired: false }],
        archive: "unexpected-string",
      },
    ]) {
      const rest = {
        rest: {
          actions: {
            getWorkflowRun: async () => ({
              data: {
                id: 10,
                path: ".github/workflows/pr-agent.yml",
                status: "completed",
                repository: { full_name: "octocat/hello-world" },
              },
            }),
            listWorkflowRunArtifacts: async () => ({ data: { artifacts: scenario.artifacts } }),
            downloadArtifact: async () => ({ data: scenario.archive }),
            listWorkflowRuns: async () => ({ data: { workflow_runs: [] } }),
          },
        },
      } as unknown as Octokit;

      const result = await collectPrAgentProvenance({
        rest,
        retry: directRetry,
        owner: "octocat",
        repo: "hello-world",
        pullRequestNumber: 1,
        headSha,
        checkRunUrls: [
          null,
          "https://ci.example.test/1",
          "https://github.com/octocat/hello-world/actions/runs/10/job/1",
        ],
      });

      expect(result.status).toBe("unverified");
    }
  });

  it.each([1, 2])(
    "validates schema %s after a per-check run lookup returns 403",
    async (schemaVersion) => {
      const body = "<!-- pr-agent:review:full -->";
      const digest = digestCommentBody(body);
      const zip = Buffer.from(
        makeZip(
          "pr-agent-provenance.json",
          JSON.stringify({
            schema_version: schemaVersion,
            workflow_path: ".github/workflows/pr-agent.yml",
            run_id: 30,
            repository: "octocat/hello-world",
            pull_request_number: 1,
            head_sha: headSha,
            comment_id: 9,
            body_digest: digest,
          }),
        ),
      );

      const rest = {
        rest: {
          actions: {
            getWorkflowRun: async () => {
              throw { status: 403 };
            },
            listWorkflowRuns: async () => ({
              data: {
                workflow_runs: [
                  {
                    id: 30,
                    path: ".github/workflows/pr-agent.yml",
                    status: "completed",
                    repository: { full_name: "octocat/hello-world" },
                  },
                ],
              },
            }),
            listWorkflowRunArtifacts: async () => ({
              data: {
                artifacts: [{ id: 3, name: "pr-agent-review-provenance", expired: false }],
              },
            }),
            downloadArtifact: async () => ({ data: zip }),
          },
        },
      } as unknown as Octokit;

      const result = await collectPrAgentProvenance({
        rest,
        retry: directRetry,
        owner: "octocat",
        repo: "hello-world",
        pullRequestNumber: 1,
        headSha,
        checkRunUrls: ["https://github.com/octocat/hello-world/actions/runs/999/job/1"],
      });

      if (schemaVersion === 1) {
        expect(result).toEqual({
          status: "unavailable",
          workflowPath: null,
          runId: null,
          headSha: null,
          commentId: null,
          bodyDigest: null,
        });
        return;
      }
      expect(result).toEqual({
        status: "verified",
        workflowPath: ".github/workflows/pr-agent.yml",
        runId: 30,
        headSha,
        commentId: 9,
        bodyDigest: digest,
      });
    },
  );

  it("handles 403 artifact download permissions and rethrows unexpected errors", async () => {
    const rest403 = {
      rest: {
        actions: {
          listWorkflowRuns: async () => ({
            data: {
              workflow_runs: [
                {
                  id: 20,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  repository: { full_name: "octocat/hello-world" },
                },
              ],
            },
          }),
          listWorkflowRunArtifacts: async () => ({
            data: {
              artifacts: [{ id: 2, name: "pr-agent-review-provenance", expired: false }],
            },
          }),
          downloadArtifact: async () => {
            throw { status: 403 };
          },
        },
      },
    } as unknown as Octokit;

    const unavailable = await collectPrAgentProvenance({
      rest: rest403,
      retry: directRetry,
      owner: "octocat",
      repo: "hello-world",
      pullRequestNumber: 1,
      headSha,
      checkRunUrls: [],
    });
    expect(unavailable.status).toBe("unavailable");

    const rest500 = {
      rest: {
        actions: {
          listWorkflowRuns: async () => {
            throw { response: { status: 500 } };
          },
        },
      },
    } as unknown as Octokit;

    await expect(
      collectPrAgentProvenance({
        rest: rest500,
        retry: directRetry,
        owner: "octocat",
        repo: "hello-world",
        pullRequestNumber: 1,
        headSha,
        checkRunUrls: [],
      }),
    ).rejects.toEqual({ response: { status: 500 } });

    const restPrimitiveError = {
      rest: {
        actions: {
          listWorkflowRuns: async () => {
            throw "primitive-network-failure";
          },
        },
      },
    } as unknown as Octokit;

    await expect(
      collectPrAgentProvenance({
        rest: restPrimitiveError,
        retry: directRetry,
        owner: "octocat",
        repo: "hello-world",
        pullRequestNumber: 1,
        headSha,
        checkRunUrls: [],
      }),
    ).rejects.toBe("primitive-network-failure");

    const restDeniedWithUnrelatedRun = {
      rest: {
        actions: {
          getWorkflowRun: async () => {
            throw { status: 403 };
          },
          listWorkflowRuns: async () => ({
            data: {
              workflow_runs: [
                {
                  id: 40,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  repository: { full_name: "octocat/hello-world" },
                },
              ],
            },
          }),
          listWorkflowRunArtifacts: async () => ({ data: { artifacts: [] } }),
        },
      },
    } as unknown as Octokit;

    const deniedResult = await collectPrAgentProvenance({
      rest: restDeniedWithUnrelatedRun,
      retry: directRetry,
      owner: "octocat",
      repo: "hello-world",
      pullRequestNumber: 1,
      headSha,
      checkRunUrls: ["https://github.com/octocat/hello-world/actions/runs/998/job/1"],
    });
    expect(deniedResult.status).toBe("unavailable");

    const restNonStatusObject = {
      rest: {
        actions: {
          listWorkflowRuns: async () => {
            throw { status: "not-a-number" };
          },
        },
      },
    } as unknown as Octokit;

    await expect(
      collectPrAgentProvenance({
        rest: restNonStatusObject,
        retry: directRetry,
        owner: "octocat",
        repo: "hello-world",
        pullRequestNumber: 1,
        headSha,
        checkRunUrls: [],
      }),
    ).rejects.toEqual({ status: "not-a-number" });

    expect(digestCommentBody("test")).toHaveLength(64);
  });

  it("orders fallback workflow runs newest-first and skips transient 404 artifacts", async () => {
    const newBody = "<!-- pr-agent:review:full -->\nnew";
    const oldBody = "<!-- pr-agent:review:full -->\nold";
    const newDigest = digestCommentBody(newBody);
    const oldDigest = digestCommentBody(oldBody);
    const zipFor = (runId: number, commentId: number, bodyDigest: string) =>
      Buffer.from(
        makeZip(
          "pr-agent-provenance.json",
          JSON.stringify({
            schema_version: 2,
            workflow_path: ".github/workflows/pr-agent.yml",
            run_id: runId,
            repository: "octocat/hello-world",
            pull_request_number: 1,
            head_sha: headSha,
            comment_id: commentId,
            body_digest: bodyDigest,
          }),
        ),
      );

    const artifactLookups: number[] = [];
    const rest = {
      rest: {
        actions: {
          listWorkflowRuns: async () => ({
            data: {
              workflow_runs: [
                {
                  id: 40,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  head_sha: headSha,
                  updated_at: "2026-10-01T12:00:00Z",
                  repository: { full_name: "octocat/hello-world" },
                },
                {
                  id: 55,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  head_sha: "base-sha",
                  updated_at: "2026-10-01T12:10:00Z",
                  repository: { full_name: "octocat/hello-world" },
                },
                {
                  id: 50,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  head_sha: headSha,
                  updated_at: "2026-10-01T12:05:00Z",
                  repository: { full_name: "octocat/hello-world" },
                },
              ],
            },
          }),
          listWorkflowRunArtifacts: async ({ run_id }: { run_id: number }) => {
            artifactLookups.push(run_id);
            if (run_id === 55) {
              throw { status: 404 };
            }
            return {
              data: {
                artifacts: [{ id: run_id, name: "pr-agent-review-provenance", expired: false }],
              },
            };
          },
          downloadArtifact: async ({ artifact_id }: { artifact_id: number }) => ({
            data: artifact_id === 50 ? zipFor(50, 200, newDigest) : zipFor(40, 100, oldDigest),
          }),
        },
      },
    } as unknown as Octokit;

    const result = await collectPrAgentProvenance({
      rest,
      retry: directRetry,
      owner: "octocat",
      repo: "hello-world",
      pullRequestNumber: 1,
      headSha,
      checkRunUrls: [],
    });

    expect(artifactLookups).toEqual([55, 50]);
    expect(result).toEqual({
      status: "verified",
      workflowPath: ".github/workflows/pr-agent.yml",
      runId: 50,
      headSha,
      commentId: 200,
      bodyDigest: newDigest,
    });
  });

  it("prefers newer check_run URLs and keeps searching fallback runs until comment digest matches", async () => {
    const oldBody = "<!-- pr-agent:review:full -->\nold-on-same-sha";
    const newBody = "<!-- pr-agent:review:full -->\nnew-issue-comment-on-same-sha";
    const oldDigest = digestCommentBody(oldBody);
    const newDigest = digestCommentBody(newBody);
    const zipFor = (runId: number, commentId: number, bodyDigest: string) =>
      Buffer.from(
        makeZip(
          "pr-agent-provenance.json",
          JSON.stringify({
            schema_version: 2,
            workflow_path: ".github/workflows/pr-agent.yml",
            run_id: runId,
            repository: "octocat/hello-world",
            pull_request_number: 1,
            head_sha: headSha,
            comment_id: commentId,
            body_digest: bodyDigest,
          }),
        ),
      );

    const restSameSha = {
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }: { run_id: number }) => ({
            data: {
              id: run_id,
              path: ".github/workflows/pr-agent.yml",
              status: "completed",
              repository: { full_name: "octocat/hello-world" },
            },
          }),
          listWorkflowRuns: async () => ({
            data: {
              workflow_runs: [
                {
                  id: 30,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  head_sha: "base-sha",
                  updated_at: "2026-10-01T12:15:00Z",
                  repository: { full_name: "octocat/hello-world" },
                },
              ],
            },
          }),
          listWorkflowRunArtifacts: async ({ run_id }: { run_id: number }) => ({
            data: {
              artifacts: [{ id: run_id, name: "pr-agent-review-provenance-pr-1", expired: false }],
            },
          }),
          downloadArtifact: async ({ artifact_id }: { artifact_id: number }) => ({
            data:
              artifact_id === 30
                ? zipFor(30, 9, newDigest)
                : artifact_id === 20
                  ? zipFor(20, 9, oldDigest)
                  : zipFor(10, 9, oldDigest),
          }),
        },
      },
    } as unknown as Octokit;

    const refreshed = await collectPrAgentProvenance({
      rest: restSameSha,
      retry: directRetry,
      owner: "octocat",
      repo: "hello-world",
      pullRequestNumber: 1,
      headSha,
      checkRunUrls: [
        "https://github.com/octocat/hello-world/actions/runs/10/job/1",
        "https://github.com/octocat/hello-world/actions/runs/20/job/2",
      ],
      commentDigests: new Map([[9, newDigest]]),
    });

    expect(refreshed).toEqual({
      status: "verified",
      workflowPath: ".github/workflows/pr-agent.yml",
      runId: 30,
      headSha,
      commentId: 9,
      bodyDigest: newDigest,
    });

    // Comment-triggered runs must outrank older check URLs on the same head.
    const newerCheckWins = await collectPrAgentProvenance({
      rest: restSameSha,
      retry: directRetry,
      owner: "octocat",
      repo: "hello-world",
      pullRequestNumber: 1,
      headSha,
      checkRunUrls: [
        "https://github.com/octocat/hello-world/actions/runs/10/job/1",
        "https://github.com/octocat/hello-world/actions/runs/20/job/2",
      ],
    });
    expect(newerCheckWins.runId).toBe(30);
  });

  it.each([false, true])(
    "preserves known check-linked runs beyond fallback limits: %s",
    async (checkLinked) => {
      const body = "<!-- pr-agent:review:full -->\npr1";
      const digest = digestCommentBody(body);
      const zip = Buffer.from(
        makeZip(
          "pr-agent-provenance.json",
          JSON.stringify({
            schema_version: 2,
            workflow_path: ".github/workflows/pr-agent.yml",
            run_id: 100,
            repository: "octocat/hello-world",
            pull_request_number: 1,
            head_sha: "a".repeat(40),
            comment_id: 7,
            body_digest: digest,
          }),
        ),
      );

      const rest = {
        rest: {
          actions: {
            getWorkflowRun: async () => ({
              data: {
                id: 100,
                path: ".github/workflows/pr-agent.yml",
                status: "completed",
                head_sha: headSha,
                updated_at: "2026-10-01T12:00:00Z",
                repository: { full_name: "octocat/hello-world" },
              },
            }),
            listWorkflowRuns: async () => ({
              data: {
                workflow_runs: [
                  ...Array.from({ length: checkLinked ? 60 : 6 }, (_, index) => ({
                    id: 200 + index,
                    path: ".github/workflows/pr-agent.yml",
                    status: "completed",
                    pull_requests: index % 2 === 0 ? [{ number: 2 }] : [],
                    updated_at: "2026-10-01T12:20:00Z",
                    repository: { full_name: "octocat/hello-world" },
                  })),
                  {
                    id: 100,
                    path: ".github/workflows/pr-agent.yml",
                    status: "completed",
                    pull_requests: [],
                    updated_at: "2026-10-01T12:00:00Z",
                    repository: { full_name: "octocat/hello-world" },
                  },
                ],
              },
            }),
            listWorkflowRunArtifacts: async ({ run_id }: { run_id: number }) => ({
              data: {
                artifacts: [
                  {
                    id: run_id,
                    name:
                      run_id === 100
                        ? "pr-agent-review-provenance-pr-1"
                        : "pr-agent-review-provenance-pr-2",
                    expired: false,
                  },
                ],
              },
            }),
            downloadArtifact: async () => ({ data: zip }),
          },
        },
      } as unknown as Octokit;

      const result = await collectPrAgentProvenance({
        rest,
        retry: directRetry,
        owner: "octocat",
        repo: "hello-world",
        pullRequestNumber: 1,
        headSha: "a".repeat(40),
        checkRunUrls: checkLinked
          ? ["https://github.com/octocat/hello-world/actions/runs/100/job/1"]
          : [],
        commentDigests: new Map([[7, digest]]),
      });

      expect(result).toEqual({
        status: "verified",
        workflowPath: ".github/workflows/pr-agent.yml",
        runId: 100,
        headSha: "a".repeat(40),
        commentId: 7,
        bodyDigest: digest,
      });
    },
  );

  it("retries in-progress check_run runs via completed listing and treats 410 artifact downloads as missing", async () => {
    const body = "<!-- pr-agent:review:full -->\nready";
    const digest = digestCommentBody(body);
    const zip = Buffer.from(
      makeZip(
        "pr-agent-provenance.json",
        JSON.stringify({
          schema_version: 2,
          workflow_path: ".github/workflows/pr-agent.yml",
          run_id: 300,
          repository: "octocat/hello-world",
          pull_request_number: 1,
          head_sha: headSha,
          comment_id: 12,
          body_digest: digest,
        }),
      ),
    );

    const rest = {
      rest: {
        actions: {
          getWorkflowRun: async () => ({
            data: {
              id: 300,
              path: ".github/workflows/pr-agent.yml",
              status: "in_progress",
              repository: { full_name: "octocat/hello-world" },
            },
          }),
          listWorkflowRuns: async () => ({
            data: {
              workflow_runs: [
                {
                  id: 301,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  updated_at: "2026-10-01T12:10:00Z",
                  repository: { full_name: "octocat/hello-world" },
                },
                {
                  id: 300,
                  path: ".github/workflows/pr-agent.yml",
                  status: "completed",
                  updated_at: "2026-10-01T12:05:00Z",
                  repository: { full_name: "octocat/hello-world" },
                },
              ],
            },
          }),
          listWorkflowRunArtifacts: async ({ run_id }: { run_id: number }) => ({
            data: {
              artifacts: [{ id: run_id, name: "pr-agent-review-provenance-pr-1", expired: false }],
            },
          }),
          downloadArtifact: async ({ artifact_id }: { artifact_id: number }) => {
            if (artifact_id === 301) {
              throw { status: 410 };
            }
            return { data: zip };
          },
        },
      },
    } as unknown as Octokit;

    const result = await collectPrAgentProvenance({
      rest,
      retry: directRetry,
      owner: "octocat",
      repo: "hello-world",
      pullRequestNumber: 1,
      headSha,
      checkRunUrls: ["https://github.com/octocat/hello-world/actions/runs/300/job/1"],
      commentDigests: new Map([[12, digest]]),
    });

    expect(result).toEqual({
      status: "verified",
      workflowPath: ".github/workflows/pr-agent.yml",
      runId: 300,
      headSha,
      commentId: 12,
      bodyDigest: digest,
    });
  });
});
