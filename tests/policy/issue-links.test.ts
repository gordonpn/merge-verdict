import { describe, expect, it } from "vitest";
import { checkIssueLinks } from "../../src/policy/issue-links.js";

describe("checkIssueLinks", () => {
  it.each([
    "Closes #123",
    "[Issue](https://github.com/org/repo/issues/123)",
    "<https://github.com/org/repo/issues/123>",
    "Fixes #123",
    "Resolves #123",
    "#123",
    "org/repo#123",
    "https://github.com/org/repo/issues/123",
  ])("accepts %s", (body) => {
    expect(checkIssueLinks(body)).toEqual({
      references: [{ repository: body.includes("org") ? "org/repo" : null, number: 123 }],
      failureMessage: null,
    });
  });

  it.each([
    null,
    "",
    "No issue",
    "#<!-- template -->123",
    "[#123][external]\n\n[external]: https://example.com",
    "````\n#123\n```\n#456",
    "<!-- #123",
    "#0 #01 #-1 #1.2 #123abc #999999999999999999999",
    "Closes #<number> #ISSUE_NUMBER",
    "```md\n#123\n```",
    "~~~\n#123\n~~~",
    "    #123\n\t#456",
    "`#123` and ``code ` #456``",
    "<!--\nCloses #123\n-->",
    "https://example.com/org/repo/issues/123",
    "https://github.com.evil/org/repo/issues/123",
    "https://github.com/org/repo/pull/123",
    "https://example.com/path#123",
    "word#123",
    "bad/org/repo#123",
    "[#123](https://example.com)",
    "![#123](image.png)",
  ])("rejects excluded or invalid content %s", (body) => {
    const result = checkIssueLinks(body);
    expect(result.references).toEqual([]);
    expect(result.failureMessage).toContain("Add an issue reference");
    expect(result.failureMessage).toContain("Closes #123");
  });

  it("keeps visible references after ignored content and deduplicates targets", () => {
    expect(
      checkIssueLinks("<!-- #1 --> `#2`\n```\n#3\n```\n#4 and #4 and org/repo#5").references,
    ).toEqual([
      { repository: null, number: 4 },
      { repository: "org/repo", number: 5 },
    ]);
  });
});
