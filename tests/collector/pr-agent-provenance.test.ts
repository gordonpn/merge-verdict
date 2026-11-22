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
        archive: makeZip("pr-agent-provenance.json", '{"schema_version":2}'),
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

  it("continues to listWorkflowRuns fallback when a per-check run lookup returns 403", async () => {
    const body = "<!-- pr-agent:review:full -->";
    const digest = digestCommentBody(body);
    const zip = Buffer.from(
      makeZip(
        "pr-agent-provenance.json",
        JSON.stringify({
          schema_version: 1,
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

    expect(result).toEqual({
      status: "verified",
      workflowPath: ".github/workflows/pr-agent.yml",
      runId: 30,
      headSha,
      commentId: 9,
      bodyDigest: digest,
    });
  });

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

    expect(digestCommentBody("test")).toHaveLength(64);
  });
});
