import { describe, expect, it } from "vitest";
import {
  CHECK_RUN_CONCLUSIONS,
  CHECK_RUN_STATUSES,
  CheckRunConclusionSchema,
  CheckRunRecordSchema,
  CheckRunStatusSchema,
} from "../../src/models/check-run.js";

describe("CheckRunStatusSchema", () => {
  it("parses all valid check run statuses", () => {
    for (const status of CHECK_RUN_STATUSES) {
      expect(CheckRunStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects invalid check run status values", () => {
    const invalidStatuses = ["pending", "done", "finished", ""];
    for (const invalid of invalidStatuses) {
      expect(() => CheckRunStatusSchema.parse(invalid)).toThrow();
    }
  });
});

describe("CheckRunConclusionSchema", () => {
  it("parses all valid check run conclusions", () => {
    for (const conclusion of CHECK_RUN_CONCLUSIONS) {
      expect(CheckRunConclusionSchema.parse(conclusion)).toBe(conclusion);
    }
  });

  it("rejects invalid check run conclusions", () => {
    const invalidConclusions = ["passed", "failed", "completed", ""];
    for (const invalid of invalidConclusions) {
      expect(() => CheckRunConclusionSchema.parse(invalid)).toThrow();
    }
  });
});

describe("CheckRunRecordSchema", () => {
  const validCheckRun = {
    name: "runner / test",
    status: "completed" as const,
    conclusion: "success" as const,
    commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    detailsUrl: "https://github.com/owner/repo/actions/runs/12345",
  };

  it("parses valid completed check run record", () => {
    const parsed = CheckRunRecordSchema.parse(validCheckRun);
    expect(parsed.name).toBe("runner / test");
    expect(parsed.status).toBe("completed");
    expect(parsed.conclusion).toBe("success");
  });

  it("parses in-progress check run with null conclusion", () => {
    const inProgress = {
      ...validCheckRun,
      status: "in_progress" as const,
      conclusion: null,
    };
    const parsed = CheckRunRecordSchema.parse(inProgress);
    expect(parsed.status).toBe("in_progress");
    expect(parsed.conclusion).toBeNull();
  });

  it("rejects invalid detailsUrl format", () => {
    const invalid = { ...validCheckRun, detailsUrl: "invalid-url" };
    expect(() => CheckRunRecordSchema.parse(invalid)).toThrow();
  });

  it("rejects empty commitSha or empty name", () => {
    expect(() => CheckRunRecordSchema.parse({ ...validCheckRun, name: "" })).toThrow();
    expect(() => CheckRunRecordSchema.parse({ ...validCheckRun, commitSha: "" })).toThrow();
  });
});
