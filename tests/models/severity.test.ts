import { describe, expect, it } from "vitest";
import { SEVERITIES, SeveritySchema } from "../../src/models/severity.js";

describe("SeveritySchema", () => {
  it("parses all valid severity levels", () => {
    for (const severity of SEVERITIES) {
      expect(SeveritySchema.parse(severity)).toBe(severity);
    }
  });

  it("rejects invalid severity strings", () => {
    const invalidValues = ["CRITICAL", "INFO", "WARN", "fatal", "", "blocker"];
    for (const invalid of invalidValues) {
      expect(() => SeveritySchema.parse(invalid)).toThrow();
    }
  });

  it("rejects non-string input types", () => {
    const invalidTypes = [null, undefined, 123, true, {}, []];
    for (const invalid of invalidTypes) {
      expect(() => SeveritySchema.parse(invalid)).toThrow();
    }
  });
});
