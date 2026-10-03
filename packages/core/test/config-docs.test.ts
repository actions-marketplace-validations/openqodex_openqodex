// Ways the docs table check could fail:
// 1. `node scripts/config-docs.mjs --check` passes when the key table in
//    docs/config.md no longer matches the schema, so the docs drift.
// Runs the real script against the real page and the built core package.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const page = join(root, "docs/config.md");
const script = join(root, "scripts/config-docs.mjs");

function check(): { code: number; stderr: string } {
  try {
    execFileSync(process.execPath, [script, "--check"], { cwd: root, stdio: "pipe" });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stderr: Buffer };
    return { code: err.status, stderr: err.stderr.toString() };
  }
}

describe("config docs check", () => {
  it("fails when a row of the key table is stale, and passes once it is restored", () => {
    const original = readFileSync(page, "utf8");
    expect(original).toContain("| `graph.max_files` | `4000` |");
    try {
      writeFileSync(page, original.replace("| `graph.max_files` | `4000` |", "| `graph.max_files` | `5000` |"));
      const stale = check();
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain("stale");
    } finally {
      writeFileSync(page, original);
    }
    expect(check().code).toBe(0);
  });
});
