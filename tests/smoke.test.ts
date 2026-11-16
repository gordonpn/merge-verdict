import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import { VERSION } from "../src/index.js";

describe("core package smoke test", () => {
  it("exports issue-link policy and publisher entry points", () => {
    expect(core).toHaveProperty("checkIssueLinks", expect.any(Function));
    expect(core).toHaveProperty("createApprovalProvider", expect.any(Function));
    expect(core).toHaveProperty("publishCheckRun", expect.any(Function));
    expect(core).toHaveProperty("publishErrorCheckRun", expect.any(Function));
    expect(core).toHaveProperty("formatChecksReport", expect.any(Function));
  });

  it("exports package version string", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
