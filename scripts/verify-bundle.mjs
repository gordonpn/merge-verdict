import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Asserts that the standalone Action ESM and CommonJS distributions export identical interfaces.
 */
export function verifyActionBundleExports(actionEsm, actionCjs) {
  assert.deepEqual(Object.keys(actionEsm).sort(), Object.keys(actionCjs).sort());
  for (const bundle of [actionEsm, actionCjs]) {
    assert.equal(typeof bundle.runAction, "function");
    assert.equal(typeof bundle.isSelfTriggeredEvent, "function");
    assert.equal(typeof bundle.extractPullRequestNumber, "function");
    assert.equal(typeof bundle.parseRepository, "function");
    assert.equal(typeof bundle.getActionInput, "function");
    assert.equal(typeof bundle.parseBooleanInput, "function");
    assert.equal(typeof bundle.writeActionOutput, "function");
    assert.equal(typeof bundle.appendStepSummary, "function");
    assert.equal(typeof bundle.shouldAutoRun, "function");
  }
}

function verifyStandaloneActionArtifacts() {
  const actionJsPath = fileURLToPath(new URL("../dist/action.js", import.meta.url));
  const actionCjsPath = fileURLToPath(new URL("../dist/action.cjs", import.meta.url));
  if (!existsSync(actionJsPath) || !existsSync(actionCjsPath)) {
    return;
  }

  const isolatedDirectory = mkdtempSync(join(tmpdir(), "merge-verdict-action-build-"));
  try {
    writeFileSync(join(isolatedDirectory, "package.json"), '{"type":"module"}');
    for (const filename of ["action.js", "action.cjs"]) {
      copyFileSync(
        new URL(`../dist/${filename}`, import.meta.url),
        join(isolatedDirectory, filename),
      );
      const map = JSON.parse(
        readFileSync(new URL(`../dist/${filename}.map`, import.meta.url), "utf8"),
      );
      assert.ok(map.sources.length > 0, `${filename} must have source mappings`);
      assert.equal(map.sources.length, map.sourcesContent.length);
      execFileSync(process.execPath, [filename], {
        cwd: isolatedDirectory,
        stdio: "inherit",
        env: { ...process.env, MERGE_VERDICT_DISABLE_AUTORUN: "true" },
      });
    }

    const previousAutorunDisable = process.env.MERGE_VERDICT_DISABLE_AUTORUN;
    process.env.MERGE_VERDICT_DISABLE_AUTORUN = "true";
    let actionCjs;
    try {
      actionCjs = createRequire(pathToFileURL(join(isolatedDirectory, "action.cjs")))(
        join(isolatedDirectory, "action.cjs"),
      );
    } finally {
      if (previousAutorunDisable === undefined) {
        delete process.env.MERGE_VERDICT_DISABLE_AUTORUN;
      } else {
        process.env.MERGE_VERDICT_DISABLE_AUTORUN = previousAutorunDisable;
      }
    }
    verifyActionBundleExports(actionCjs, actionCjs);
  } finally {
    rmSync(isolatedDirectory, { recursive: true, force: true });
  }
}

/**
 * Asserts that the standalone ESM and CommonJS distributions export identical interfaces
 * and can instantiate configuration and collectors without external dependencies.
 */
export function verifyBundleExports(esm, cjs) {
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
  for (const bundle of [esm, cjs]) {
    const config = bundle.createDefaultConfig();
    assert.equal(config.approval.requiredCheck, "merge-verdict");
    assert.equal(bundle.MergeVerdictConfigSchema.parse({}).approval.requiredCheck, "merge-verdict");
    assert.ok(
      bundle.createGitHubCollector("standalone-smoke-test") instanceof bundle.GitHubCollector,
    );
  }
  verifyStandaloneActionArtifacts();
}
