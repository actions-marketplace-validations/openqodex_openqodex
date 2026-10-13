// Failure cases: a real scanner failure leaks the checkout root, or the
// redaction removes the file and failure detail along with the root.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import { repoFacts } from "../src/detect.js";
import { runRuff } from "../src/adapters/ruff.js";
import { runScanners } from "../src/run.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

it("redacts the checkout root in a real Ruff configuration failure", async () => {
  const root = tempDir("oq-reason-paths-");
  writeFileSync(join(root, "main.py"), "import os\n");
  writeFileSync(join(root, "ruff.toml"), 'extend = "missing.toml"\n');
  const tool = { path: execFileSync("which", ["ruff"], { encoding: "utf8" }).trim(), version: execFileSync("ruff", ["--version"], { encoding: "utf8" }).trim(), env: {} };
  const raw = await runRuff({ repoDir: root, changedPaths: ["main.py"], tool, facts: repoFacts(root) });
  expect(raw.error).toContain(root);
  const { scan } = await runScanners({ repoDir: root, changedPaths: ["main.py"], config: parseConfig("").config,
    resolveTool: async () => ({ ok: true, tool }), only: ["ruff"] });
  expect(scan.scanners[0]?.status).toBe("failed");
  expect(scan.scanners[0]?.reason).toContain("<checkout>");
  expect(scan.scanners[0]?.reason).toContain("missing.toml");
  expect(scan.scanners[0]?.reason).not.toContain(root);
});
