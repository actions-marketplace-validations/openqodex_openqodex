import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { baseline, report, run } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

describe("clean repository", () => {
  it("with no change says there is nothing to review and exits 0", () => {
    const dir = baseline(); const result = run("clean-empty", dir, ["scan"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Nothing to review");
  });
  it("with a harmless edit reports no finding (no false positive on clean code)", () => {
    const dir = baseline(); appendFileSync(join(dir, "app/server.py"), "\n# Harmless comment\n");
    const result = run("clean-comment", dir, ["scan", "--format", "json"]);
    expect(result.status).toBe(0);
    expect(report(dir).findings.map((f) => `${f.file_path}:${f.source}`)).toEqual([]);
  });
});
