import assert from "node:assert/strict";

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
}
