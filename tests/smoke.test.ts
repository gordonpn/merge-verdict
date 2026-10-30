import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("core package smoke test", () => {
  it("exports package version string", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
