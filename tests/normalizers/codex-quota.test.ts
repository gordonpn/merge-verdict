import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  GitHubConversationComment,
  GitHubReviewThread,
} from "../../src/collector/github-collector.js";
import { normalizeCodexReviewer } from "../../src/normalizers/codex.js";

const headSha = "35c286dc84db8dc22ffd3e58b3457a1c77acb019";
const quotaState = readFileSync(
  new URL("../fixtures/codex/quota-state.md", import.meta.url),
  "utf8",
);
const failedState = readFileSync(
  new URL("../fixtures/codex/failed-state.md", import.meta.url),
  "utf8",
);
const quotaNotice = readFileSync(
  new URL("../fixtures/codex/quota-notice.md", import.meta.url),
  "utf8",
);

function comment(
  body: string,
  overrides: Partial<GitHubConversationComment> = {},
): GitHubConversationComment {
  return {
    id: 1,
    authorLogin: "chatgpt-codex-connector[bot]",
    body,
    bodyDigest: "digest",
    createdAt: "2026-11-17T17:49:37Z",
    updatedAt: null,
    ...overrides,
  };
}

describe("Codex quota provenance", () => {
  it.each([true, false])(
    "preserves inline finding resolution %s during quota exhaustion",
    (isResolved) => {
      const thread: GitHubReviewThread = {
        id: "thread",
        isResolved,
        resolvedByLogin: null,
        isOutdated: false,
        path: null,
        line: null,
        originalLine: null,
        comments: [
          {
            id: "finding",
            authorLogin: "chatgpt-codex-connector[bot]",
            body: "P1 security finding",
            bodyDigest: "digest",
            createdAt: "2026-11-17T17:49:37Z",
            updatedAt: "2026-11-17T17:49:37Z",
            path: null,
            line: null,
            originalLine: null,
            commitSha: headSha,
          },
        ],
      };

      const result = normalizeCodexReviewer({
        headSha,
        conversationComments: [comment(quotaState)],
        reviewThreads: [thread],
      });

      expect(result.status).toBe("RATE_LIMITED");
      expect(result.verdict).toBe(isResolved ? "NONE" : "CHANGES_REQUESTED");
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.isResolved).toBe(isResolved);
    },
  );
  it("classifies a quota diagnostic sharing the current failed state artifact", () => {
    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(quotaState)] });

    expect(result).toMatchObject({
      status: "RATE_LIMITED",
      verdict: "NONE",
      isFresh: true,
      evaluatedCommitSha: headSha,
      findings: [],
    });
  });

  it.each([
    ["a single newline after the marker", `${failedState.trimEnd()}\n${quotaNotice}`],
    [
      "removed code followed by a blank line",
      `${failedState}\n\`\`\`text\nexample\n\`\`\`\n\n${quotaNotice}`,
    ],
    [
      "removed code without a surrounding blank line",
      `${failedState}\nDiagnostic context:\n\`\`\`text\nexample\n\`\`\`\n${quotaNotice}`,
    ],
    [
      "fenced code containing an unclosed HTML tag",
      `${failedState}\n\`\`\`html\n<blockquote>example\n\`\`\`\n${quotaNotice}`,
    ],
    [
      "self-closing and stray closing excluded HTML tags",
      `${failedState}\n<code/></blockquote>\n\n${quotaNotice}`,
    ],
  ])("recognizes an explicit quota diagnostic after %s", (_kind, body) => {
    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });

    expect(result).toMatchObject({ status: "RATE_LIMITED", verdict: "NONE", isFresh: true });
  });

  it.each(["older", "missing"])("preserves SHA freshness for %s provenance", (kind) => {
    const body = quotaState.replace(headSha, kind === "older" ? "a".repeat(40) : "");

    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });

    expect(result.status).toBe("STALE");
    expect(result.isFresh).toBe(false);
  });

  it.each([
    ["quoted history", "> You have reached your Codex usage limits for code reviews."],
    [
      "lazy quote continuation",
      "> Prior diagnostic:\nYou have reached your Codex usage limits for code reviews.",
    ],
    ["unclosed fence", "```text\nYou have reached your Codex usage limits for code reviews."],
    [
      "fence-like code content",
      "```text\n```still-code\nYou have reached your Codex usage limits for code reviews.\n```",
    ],
    [
      "nested fence",
      "````text\n```\nYou have reached your Codex usage limits for code reviews.\n````",
    ],
    [
      "mismatched fence",
      "~~~text\n```\nYou have reached your Codex usage limits for code reviews.\n~~~",
    ],
    ["fenced code", "```text\nYou have reached your Codex usage limits for code reviews.\n```"],
    [
      "tilde fenced code",
      "~~~text\nYou have reached your Codex usage limits for code reviews.\n~~~",
    ],
    ["indented code", "    You have reached your Codex usage limits for code reviews."],
    ["inline code", "`You have reached your Codex usage limits for code reviews.`"],
    ["HTML code", "<pre>\nYou have reached your Codex usage limits for code reviews.\n</pre>"],
    [
      "nested HTML blockquote",
      "<blockquote><blockquote>Earlier run</blockquote>\n\nYou have reached your Codex usage limits for code reviews.\n</blockquote>",
    ],
    [
      "nested HTML pre inside blockquote",
      "<blockquote><pre>Earlier run</pre>\n\nYou have reached your Codex usage limits for code reviews.\n</blockquote>",
    ],
    [
      "misnested HTML closing tag inside blockquote",
      "<blockquote><pre>Earlier run</blockquote>\n\nYou have reached your Codex usage limits for code reviews.",
    ],
    [
      "unclosed HTML pre block",
      "<pre>\nYou have reached your Codex usage limits for code reviews.",
    ],
    [
      "self-closing HTML tag inside excluded pre block",
      "<pre><code/>\nYou have reached your Codex usage limits for code reviews.\n</pre>",
    ],
    ["HTML comment", "<!--\nYou have reached your Codex usage limits for code reviews.\n-->"],
    [
      "historical reference",
      "Previous run reported: You have reached your Codex usage limits for code reviews.",
    ],
  ])("keeps a genuine error FAILED with %s quota text", (_kind, diagnostic) => {
    const body = `${failedState}\nCurrent execution failed: internal server error.\n\n${diagnostic}`;
    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });

    expect(result).toMatchObject({ status: "FAILED", verdict: "CHANGES_REQUESTED", isFresh: true });
  });

  it("ignores quota text inside the machine-readable state marker", () => {
    const body = failedState.replace(
      '"status":"failed"',
      '"status":"failed","historical_message":"You have reached your Codex usage limits for code reviews."',
    );
    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });

    expect(result.status).toBe("FAILED");
  });

  it.each([undefined, null])("does not bind quota diagnostics to absent or null SHA %s", (sha) => {
    const body = quotaState.replace(
      `"commit_sha":"${headSha}",`,
      sha === null ? '"commit_sha":null,' : "",
    );
    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });

    expect(result).toMatchObject({
      status: "FAILED",
      verdict: "CHANGES_REQUESTED",
      isFresh: false,
      evaluatedCommitSha: null,
    });
  });

  it("preserves blocking state findings during quota exhaustion", () => {
    const body = quotaState.replace(
      '"has_unresolved_findings":false',
      '"has_unresolved_findings":true',
    );

    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });

    expect(result.status).toBe("RATE_LIMITED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("keeps a genuine failed state separate from an unbound quota notice", () => {
    const result = normalizeCodexReviewer({
      headSha,
      conversationComments: [comment(failedState), comment(quotaNotice, { id: 2 })],
    });

    expect(result.status).toBe("FAILED");
    expect(result.verdict).toBe("CHANGES_REQUESTED");
  });

  it("ignores quota-only and untrusted notices", () => {
    for (const value of [
      comment(quotaNotice),
      comment(quotaState, { authorLogin: "contributor" }),
    ]) {
      const result = normalizeCodexReviewer({ headSha, conversationComments: [value] });

      expect(result.status).toBe("PENDING");
      expect(result.evaluatedCommitSha).toBeNull();
    }
  });
});
