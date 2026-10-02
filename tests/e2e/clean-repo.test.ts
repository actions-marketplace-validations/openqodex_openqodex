import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baseline, report, run } from "./support.js";

describe("clean repository", () => {
  it("says nothing to review when the baseline has no change", () => {
    const dir = baseline(); const result = run("clean-empty", dir, ["scan"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Nothing to review");
  });
  it("reports zero findings for a harmless Python comment", () => {
    const dir = baseline(); appendFileSync(join(dir, "app/server.py"), "\n# Harmless comment\n");
    const result = run("clean-comment", dir, ["scan", "--format", "json"]);
    expect(result.status).toBe(0); expect(report(dir).findings).toHaveLength(0);
  });
});
