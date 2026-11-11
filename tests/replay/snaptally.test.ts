import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { GitHubCollector } from "../../src/collector/github-collector.js";

function load(number: number) {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/snaptally/pr-${number}.json`, import.meta.url), "utf8"),
  ) as {
    pullRequest: {
      number: number;
      head: { sha: string };
      base: { sha: string };
    };
    comments: { id: number; body: string }[];
    reviews: { body: string; commit_id: string }[];
    checks: { check_runs: { name: string; conclusion: string; head_sha: string }[] };
    statuses: unknown[];
    files: { filename: string }[];
    threads: {
      id: string;
      isResolved: boolean;
      comments: { nodes: { id: string; body: string; commit: { oid: string } }[] };
    }[];
  };
}

async function replay(number: number) {
  const fixture = load(number);
  const requests: string[] = [];
  const policy = "replay test policy placeholder";
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    let data: unknown;
    if (url === "https://api.github.com/graphql") {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      data = {
        data: {
          repository: {
            pullRequest: query.includes("reviewThreads")
              ? {
                  reviewThreads: {
                    nodes: fixture.threads,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                }
              : {
                  files: {
                    nodes: fixture.files.map((file) => ({ path: file.filename })),
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
          },
        },
      };
    } else {
      const path = decodeURIComponent(new URL(url).pathname);
      if (path.endsWith(`/pulls/${number}`)) data = fixture.pullRequest;
      else if (path.endsWith(`/issues/${number}/comments`)) data = fixture.comments;
      else if (path.endsWith("/reviews")) data = fixture.reviews;
      else if (path.endsWith("/check-runs")) data = fixture.checks;
      else if (path.endsWith("/statuses")) data = fixture.statuses;
      else if (path.endsWith("/contents/.github/merge-verdict.yml")) {
        expect(new URL(url).searchParams.get("ref")).toBe(fixture.pullRequest.base.sha);
        data = {
          type: "file",
          encoding: "base64",
          content: Buffer.from(policy).toString("base64"),
        };
      } else throw new Error(`Unrecorded request: ${url}`);
    }
    const response = new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  const collector = new GitHubCollector(
    new Octokit({ request: { fetch } }),
    graphql.defaults({ request: { fetch } }),
  );
  const result = await collector.collectPullRequest({
    owner: "fixture-owner",
    repo: "snaptally",
    pullRequestNumber: number,
  });
  expect(requests).toHaveLength(8);
  expect(result.policyContent).toBe(policy);
  return { fixture, result };
}

describe("offline recorded SnapTally collector replay", () => {
  it("matches the recorded fixture byte digests", () => {
    const provenance = JSON.parse(
      readFileSync(new URL("../fixtures/snaptally/provenance.json", import.meta.url), "utf8"),
    ) as { recordings: { number: number; fixtureSha256: string }[] };
    expect(provenance.recordings.map((recording) => recording.number)).toEqual([119, 120, 121]);
    for (const recording of provenance.recordings) {
      const bytes = readFileSync(
        new URL(`../fixtures/snaptally/pr-${recording.number}.json`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(recording.fixtureSha256);
      const text = bytes.toString("utf8");
      expect(text).not.toContain("gordonpn");
      expect(text).not.toMatch(/avatar_url|email"|authorization|ghh_/i);
    }
  });
  it.each([119, 120, 121])(
    "preserves evidence for PR #%i without network access",
    async (number) => {
      const { fixture, result } = await replay(number);
      expect(result.headSha).toBe(fixture.pullRequest.head.sha);
      expect(result.reviewThreads).toHaveLength(fixture.threads.length);
      expect(result.changedFilePaths).toEqual(fixture.files.map((file) => file.filename));
      expect(result.reviews.map((review) => review.commitSha)).toEqual(
        fixture.reviews.map((review) => review.commit_id),
      );
      expect(result.conversationComments.map((comment) => comment.body)).toEqual(
        fixture.comments.map((comment) => comment.body),
      );
      for (const thread of result.reviewThreads) {
        for (const comment of thread.comments) {
          expect(comment.commitSha).toMatch(/^[a-f0-9]{40}$/);
          expect(comment.bodyDigest).toBe(createHash("sha256").update(comment.body).digest("hex"));
        }
      }
      expect(result.checkRuns.every((check) => check.commitSha === result.headSha)).toBe(true);
    },
  );

  it("retains neutral CodeRabbit rate limit and Sourcery resolution evidence in PR #119", async () => {
    const { result } = await replay(119);
    const check = result.checkRuns.find((item) => item.name === "CodeRabbit");
    expect(check?.conclusion).toBe("neutral");
    expect(check?.output.summary).toContain("Rate limited");
    const thread = result.reviewThreads.find((item) => item.id === "PRRT_kwDOUey2HM6w-DWe");
    expect(thread?.isResolved).toBe(true);
    expect(thread?.resolvedByLogin).toBe("sourcery-ai[bot]");
    expect(thread?.comments.some((comment) => comment.body.includes("Addressed in 6d2d457"))).toBe(
      true,
    );
  });

  it("retains the older Codex review state commit in PR #120", async () => {
    const { result } = await replay(120);
    expect(result.headSha).toBe("35c286dc84db8dc22ffd3e58b3457a1c77acb019");
    const summary = result.conversationComments.find((comment) =>
      comment.body?.includes("codex-review-state:v1"),
    );
    expect(summary?.body).toContain('"commit_sha":"a895efe284efc2ebf1ef2894c9a093af929cd98f"');
    expect(result.reviewThreads.every((thread) => thread.isResolved)).toBe(true);
  });

  it("retains the divergent DeepSeek textual verdict in PR #121", async () => {
    const { result } = await replay(121);
    const review = result.reviews.find((item) =>
      item.body?.includes("Verdict: APPROVE WITH MINOR FINDINGS"),
    );
    expect(review?.commitSha).toBe("6ad1952d4b192baa0302d8ca30563a3467124a57");
    expect(result.headSha).toBe("4650b21d3d1f70faa2958a4cb09c2c5a0df675ea");
    expect(result.reviewThreads).toHaveLength(10);
    expect(result.reviewThreads.every((thread) => thread.isResolved)).toBe(true);
  });
});
