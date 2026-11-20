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

  it.each(["older", "missing"])("preserves SHA freshness for %s provenance", (kind) => {
    const body = quotaState.replace(headSha, kind === "older" ? "a".repeat(40) : "");

    const result = normalizeCodexReviewer({ headSha, conversationComments: [comment(body)] });

    expect(result.status).toBe("STALE");
    expect(result.isFresh).toBe(false);
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
