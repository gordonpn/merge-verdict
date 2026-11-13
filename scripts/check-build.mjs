import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBundleExports } from "./verify-bundle.mjs";

// Copy only distribution artifacts outside the checkout so source files and
// installed dependencies cannot hide missing bundled packages or query assets.
const isolatedDirectory = mkdtempSync(join(tmpdir(), "merge-verdict-build-"));
try {
  writeFileSync(join(isolatedDirectory, "package.json"), '{"type":"module"}');
  for (const filename of ["index.js", "index.cjs"]) {
    copyFileSync(
      new URL(`../dist/${filename}`, import.meta.url),
      join(isolatedDirectory, filename),
    );
    const map = JSON.parse(
      readFileSync(new URL(`../dist/${filename}.map`, import.meta.url), "utf8"),
    );
    assert.ok(map.sources.length > 0, `${filename} must have source mappings`);
    assert.equal(map.sources.length, map.sourcesContent.length);
    execFileSync(process.execPath, [filename], { cwd: isolatedDirectory, stdio: "inherit" });
  }

  const esm = await import(pathToFileURL(join(isolatedDirectory, "index.js")).href);
  const cjs = createRequire(pathToFileURL(join(isolatedDirectory, "index.cjs")))(
    join(isolatedDirectory, "index.cjs"),
  );
  verifyBundleExports(esm, cjs);

  console.log("Standalone ESM and CommonJS bundles passed without node_modules or query files.");
} finally {
  rmSync(isolatedDirectory, { recursive: true, force: true });
}
