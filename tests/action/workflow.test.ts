import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowDirectory = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

describe("automatic verdict workflow routing", () => {
  it("keeps configured producer names aligned with declared or registered workflow identities", () => {
    const workflow = parse(readFileSync(`${workflowDirectory}/merge-verdict.yml`, "utf8"));
    const producerNames = readdirSync(workflowDirectory)
      .filter((file) => file.endsWith(".yml") && file !== "merge-verdict.yml")
      .map((file) => parse(readFileSync(`${workflowDirectory}/${file}`, "utf8")).name);

    expect(workflow.on.workflow_run.workflows).toHaveLength(5);
    for (const name of workflow.on.workflow_run.workflows) {
      // Default setup is registered as CodeQL; this does not prove dynamic completion delivery.
      // The inactive advanced YAML is named codeql.
      expect([...producerNames, "CodeQL"]).toContain(name);
    }
    expect(workflow.on.workflow_run.workflows).not.toContain(workflow.name);
  });
});
