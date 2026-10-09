import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import { demo, report, run } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

describe("scan with an empty tools folder and installs off", () => {
  let status: number | null; let found: Report;
  beforeAll(() => {
    const dir = demo("no-tools"); mkdirSync(join(dir, "db"), { recursive: true });
    writeFileSync(join(dir, "db/unsafe.sql"), "CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;\n");
    status = run("no-tools-scan", dir, ["scan", "--no-install", "--format", "json"], { tools: tempDir("oq-empty-tools-") }).status;
    found = report(dir);
  }, 300_000);

  it("exits 0 and lists every scanner the change needs as not installed, with its reason", () => {
    expect(status).toBe(0);
    const missing = found.scanners.filter((s) => s.status === "not_installed");
    expect(missing.map((s) => s.scanner).sort()).toEqual(["actionlint", "bandit", "checkov", "gitleaks", "hadolint", "kube-linter", "kubeconform", "osv-scanner", "ruff", "semgrep", "shellcheck", "sqlfluff", "squawk", "tflint", "trivy", "zizmor"]);
    expect(missing.filter((s) => !s.reason)).toEqual([]);
  });
  it("still runs the in-process SQL scanner", () => {
    expect(found.findings.some((f) => f.source === "sqllint:security-definer-no-search-path")).toBe(true);
  });
});
