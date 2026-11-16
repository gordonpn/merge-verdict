import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checker = resolve("scripts/check-docs.py");
const temporaryDirectories: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "foreign documentation clone "));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "docs", "nested"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Example\n");
  writeFileSync(join(root, "docs", "some file.md"), "# Details\n");
  return root;
}

function check(root: string) {
  const result = spawnSync("python3", [checker, "--root", root], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  return result;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable documentation checks", () => {
  it("resolves document links, repository links, and encoded file URLs from another cwd", () => {
    const root = fixture();
    const localUrl = pathToFileURL(join(root, "docs", "some file.md")).href;
    writeFileSync(
      join(root, "docs", "nested", "guide.md"),
      [
        "[Document relative](../some%20file.md#details)",
        "[Repository relative](/docs/some%20file.md)",
        "[Root relative](/README.md)",
        `[Local file](${localUrl}#details)`,
        "[Angle path](<../some file.md>)",
        "[Anchor](#section)",
        "[Web](https://example.com/missing)",
        "[Mail](mailto:example@example.com)",
      ].join("\n"),
    );
    const result = check(root);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("rejects genuinely missing relative links and file URLs", () => {
    const root = fixture();
    const missingUrl = pathToFileURL(join(root, "missing.md")).href;
    writeFileSync(
      join(root, "docs", "nested", "broken.md"),
      `[Missing](../missing.md)\n[Missing file](${missingUrl})\n`,
    );
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Broken link in docs/nested/broken.md: ../missing.md");
    expect(result.stdout).toContain(missingUrl);
  });

  it("checks titled and balanced-parenthesis destinations", () => {
    const root = fixture();
    writeFileSync(
      join(root, "README.md"),
      [
        "[Single](missing.md 'title')",
        "[Parenthesized](missing.md (title))",
        "[Balanced](missing(part).md)",
      ].join("\n"),
    );
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout.match(/Broken link/g)).toHaveLength(3);
    writeFileSync(join(root, "missing.md"), "");
    writeFileSync(join(root, "missing(part).md"), "");
    expect(check(root).status).toBe(0);
  });

  it("rejects outside paths, symlink escapes, ambiguous fallback and unknown schemes", () => {
    const root = fixture();
    const outside = fixture();
    symlinkSync(outside, join(root, "escape"), "dir");
    writeFileSync(
      join(root, "docs", "nested", "guide.md"),
      [
        `[Outside](${pathToFileURL(join(outside, "README.md")).href})`,
        `[Relative outside](${relative(join(root, "docs", "nested"), join(outside, "README.md"))})`,
        "[Symlink](/escape/README.md)",
        "[Fallback](README.md)",
        "[Typo](htps://example.com)",
      ].join("\n"),
    );
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout.match(/Broken link/g)).toHaveLength(5);
  });

  it("decodes repository root paths", () => {
    const root = fixture();
    writeFileSync(join(root, "README.md"), "[Encoded](/docs/some%20file.md)");
    expect(check(root).status).toBe(0);
  });

  it("fails closed on traversal errors and converts native file URL paths", () => {
    const result = spawnSync("python3", [resolve("tests/tooling/check-docs-unit.py")], {
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    "\u2764\ufe0f",
    "\u2764",
    "\u263a",
    "\u{1f600}",
    "\u{1fae9}",
    "1\ufe0f\u20e3",
    "#\u20e3",
    "*\ufe0f\u20e3",
    "\u{1f469}\u200d\u{1f4bb}",
    "\u{1f1e8}\u{1f1e6}",
  ])("rejects emoji throughout fenced code examples: %s", (emoji) => {
    const root = fixture();
    writeFileSync(join(root, "README.md"), `# Example\n\`\`\`text\n${emoji}\n\`\`\`\n`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Emoji found in README.md");
  });

  it("accepts supplementary text and incomplete sequence components", () => {
    const root = fixture();
    writeFileSync(
      join(root, "README.md"),
      "# Text\n0123456789 # * ! ? . , + - =\n\u{20000} \u{1d11e}\n\ufe0f \ufe0e \u200d \u20e3 1\ufe0f A\u20e3\n",
    );
    expect(check(root).status).toBe(0);
  });

  it("keeps punctuation and emoji checks while excluding dependencies", () => {
    const root = fixture();
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "ignored.md"), "[Missing](absent.md)");
    expect(check(root).status).toBe(0);
    writeFileSync(join(root, "docs", "invalid.md"), "Invalid \u2014 \u2013 \u{1f600}\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Em or en dash found in docs/invalid.md");
    expect(result.stdout).toContain("Emoji found in docs/invalid.md");
  });

  it("validates used full, collapsed, and shortcut reference links against definitions", () => {
    const root = fixture();
    writeFileSync(
      join(root, "README.md"),
      [
        "[Guide][guide]",
        "[collapsed][]",
        "[shortcut]",
        "![Diagram][diagram]",
        "[Unresolved][missing-def]",
        "[missing-collapsed-def][]",
        "[guide]: missing.md",
        "[collapsed]: missing-collapsed.md 'title'",
        "[shortcut]: missing-shortcut.md (title)",
        "[diagram]: missing-diagram.png",
        '  "next-line title"',
        "[unused]: absent-unused.md",
        "Ordinary [unreferenced] bracketed prose.",
      ].join("\n"),
    );
    const failed = check(root);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Broken link in README.md: missing.md");
    expect(failed.stdout).toContain("Broken link in README.md: missing-collapsed.md");
    expect(failed.stdout).toContain("Broken link in README.md: missing-shortcut.md");
    expect(failed.stdout).toContain("Broken link in README.md: missing-diagram.png");
    expect(failed.stdout).toContain("Broken link in README.md: [missing-def]");
    expect(failed.stdout).toContain("Broken link in README.md: [missing-collapsed-def]");
    expect(failed.stdout).not.toContain("absent-unused.md");
    expect(failed.stdout.match(/Broken link/g)).toHaveLength(6);

    writeFileSync(join(root, "missing.md"), "");
    writeFileSync(join(root, "missing-collapsed.md"), "");
    writeFileSync(join(root, "missing-shortcut.md"), "");
    writeFileSync(join(root, "missing-diagram.png"), "");
    writeFileSync(
      join(root, "README.md"),
      [
        "[Guide][guide]",
        "[collapsed][]",
        "[shortcut]",
        "![Diagram][diagram]",
        "[guide]: missing.md",
        "[collapsed]: missing-collapsed.md 'title'",
        "[shortcut]: missing-shortcut.md (title)",
        "[diagram]: missing-diagram.png",
        '  "next-line title"',
        "[unused]: absent-unused.md",
        "Ordinary [unreferenced] bracketed prose.",
      ].join("\n"),
    );
    const passed = check(root);
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
  });

  it("normalizes reference labels, unwraps angle-bracket destinations, and uses the first duplicate definition", () => {
    const root = fixture();
    writeFileSync(
      join(root, "docs", "guide.md"),
      [
        "[Normalized][my guide]",
        "[MY   GUIDE][]",
        "[My\n  Guide]",
        "[Angle][angle]",
        "[First wins][dup]",
        "",
        "[My   Guide]: ../README.md",
        '[angle]: <some file.md> "title"',
        "[dup]: ../README.md",
        "[DUP]: missing-duplicate.md",
      ].join("\n"),
    );
    const passed = check(root);
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);

    writeFileSync(
      join(root, "docs", "broken-dup.md"),
      ["[First wins][dup]", "", "[dup]: missing-first.md", "[dup]: ../README.md"].join("\n"),
    );
    const failed = check(root);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Broken link in docs/broken-dup.md: missing-first.md");
  });

  it("ignores inline code, fenced code blocks, indented code blocks, and HTML comments during link extraction", () => {
    const root = fixture();
    writeFileSync(
      join(root, "README.md"),
      [
        "Inline `[Example](missing-inline.md)` and ``[Double](missing-double.md) ` [StillCode](missing.md)``.",
        "Inline reference `[Guide][code-def]` with definition in prose should not resolve.",
        "",
        "```md",
        "[Fenced](missing-fenced.md)",
        "[FencedRef][fenced-def]",
        "[fenced-def]: missing-fenced-def.md",
        "[prose-ref]: missing-from-fence.md",
        "```",
        "",
        "~~~markdown",
        "[Tilde](missing-tilde.md)",
        "~~~",
        "",
        "- ```",
        "  [ListFenced](missing-list-fenced.md)",
        "  ```",
        "",
        "> > ```",
        "> > [QuotedFenced](missing-quoted-fenced.md)",
        "> [VisibleAfterQuoteFence](docs/some%20file.md)",
        "",
        "    [IndentedSpaces](missing-indented-spaces.md)",
        "\t[IndentedTab](missing-indented-tab.md)",
        "",
        "<!-- [CommentLink](missing-comment.md) -->",
        "",
        "Unmatched ` backtick in prose keeps [VisibleLink](docs/some%20file.md) active.",
        "[ProseRef][prose-ref]",
        "[prose-ref]: docs/some%20file.md",
      ].join("\n"),
    );
    const passed = check(root);
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);

    writeFileSync(
      join(root, "docs", "after-code.md"),
      [
        "`[Ignored](missing-code.md)`",
        "",
        "```md",
        "[IgnoredFence](missing-fence.md)",
        "```",
        "",
        "Unmatched ` backtick before [BrokenAfterCode](missing-real.md).",
      ].join("\n"),
    );
    const failed = check(root);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Broken link in docs/after-code.md: missing-real.md");
    expect(failed.stdout.match(/Broken link/g)).toHaveLength(1);
  });

  it("still rejects forbidden dashes and emojis inside inline and fenced code", () => {
    const root = fixture();
    writeFileSync(
      join(root, "docs", "inline-code-dash.md"),
      "Inline `em dash \u2014 and en dash \u2013` in code.\n",
    );
    const inlineDash = check(root);
    expect(inlineDash.status).toBe(1);
    expect(inlineDash.stdout).toContain("Em or en dash found in docs/inline-code-dash.md");

    rmSync(join(root, "docs", "inline-code-dash.md"));
    writeFileSync(
      join(root, "docs", "fenced-code-emoji.md"),
      ["```md", "[Ignored](missing.md) \u{1f600} \u2014", "```"].join("\n"),
    );
    const fenced = check(root);
    expect(fenced.status).toBe(1);
    expect(fenced.stdout).toContain("Em or en dash found in docs/fenced-code-emoji.md");
    expect(fenced.stdout).toContain("Emoji found in docs/fenced-code-emoji.md");
    expect(fenced.stdout).not.toContain("Broken link");
  });
});
