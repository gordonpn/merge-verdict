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
});
