import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from 'node:assert/strict';
       import { createRequire } from 'node:module';
       import * as esm from './index.js';
       const cjs = createRequire(import.meta.url)('./index.cjs');
       assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
       for (const bundle of [esm, cjs]) {
         const config = bundle.createDefaultConfig();
         assert.equal(config.approval.requiredCheck, 'merge-verdict');
         assert.equal(bundle.MergeVerdictConfigSchema.parse({}).approval.requiredCheck, 'merge-verdict');
         assert.ok(bundle.createGitHubCollector('standalone-smoke-test') instanceof bundle.GitHubCollector);
       }`,
    ],
    { cwd: isolatedDirectory, stdio: "inherit" },
  );
  console.log("Standalone ESM and CommonJS bundles passed without node_modules or query files.");
} finally {
  rmSync(isolatedDirectory, { recursive: true, force: true });
}
