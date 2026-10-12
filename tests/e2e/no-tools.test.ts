// Failure cases: installs off still says Passed; outputs disagree; missing scanners change the exit code.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import { demo, readBrief, report, reportDir, root, run, submission } from "./support.js";
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

describe("demo with installs off in a fresh home", () => {
  let result: ReturnType<typeof run>; let finalized: ReturnType<typeof run>; let outputs: string[];
  beforeAll(() => {
    const home = tempDir("oq-demo-no-install-home-");
    const dir = join(tempDir("oq-demo-no-install-"), "repo");
    result = run("demo-no-install", root, ["demo", dir, "--no-install", "--no-color"], { home, tools: join(home, ".openqodex") });
    outputs = [result.stdout, readFileSync(join(reportDir(dir), "report.md"), "utf8")];
    const options = { home, tools: join(home, ".openqodex") };
    const agent = run("demo-no-install-agent", dir, ["review", "--agent", "--no-install"], options);
    expect(agent.status, agent.stderr).toBe(0);
    const brief = readBrief(dir);
    writeFileSync(join(brief.path, "agent-findings.json"), JSON.stringify(submission(brief.changeId, brief.candidates, [])));
    finalized = run("demo-no-install-finalize", dir, ["review", "--finalize", "--no-color"], options);
    outputs.push(finalized.stdout, ...["report.md", "report.html"].map((name) => readFileSync(join(reportDir(dir), name), "utf8")));
  });
  it("never says Passed when selected scanners were not installed, in terminal, markdown or HTML", () => {
    for (const output of outputs) {
      expect(output).toContain("No findings from 1 of 17 scanners; 16 did not run (16 not installed)");
      expect(output).not.toContain("Passed");
    }
  });
  it("keeps exit 0 when selected scanners were not installed", () => {
    expect(result.status).toBe(0);
    expect(finalized.status, finalized.stderr).toBe(0);
  });
});
