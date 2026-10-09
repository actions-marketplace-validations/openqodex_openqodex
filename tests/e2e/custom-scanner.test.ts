import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { demo, report, run, skipNetwork, writeConfig } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// A custom scanner from GitHub releases, on the demo repo's workflow file. Trust
// is per repository in the shared tools folder, so each fresh demo repo starts
// untrusted; --only keeps each scan to the custom entry.
const command = "actionlint -no-color -format '{{json .}}' {target}";
const yaml = (runLine: string) => `scanners:\n  custom:\n    - source: https://github.com/rhysd/actionlint\n      version: "1.7.12"\n      run: ${JSON.stringify(runLine)}\n      format: json-map\n      map: { items: ".", file: filepath, line: line, rule: kind, message: message }\n      paths: [".github/workflows/*.yml"]\n`;
const row = (r: Report) => r.scanners.find((s) => s.scanner === "custom:actionlint");
const customFindings = (r: Report) => r.findings.filter((f) => f.source?.startsWith("custom:actionlint:")).map((f) => f.source);

describe.skipIf(skipNetwork("custom actionlint release"))("custom scanner", () => {
  let dir: string;
  const scan = (label: string) => { const r = run(label, dir, ["scan", "--only", "custom:actionlint", "--format", "json"]); if (r.status !== 0) throw new Error(`scan exited ${r.status}: ${r.stderr}`); return report(dir); };
  beforeAll(() => { dir = demo("custom"); writeConfig(dir, yaml(command)); }, 300_000);

  it("never runs before the developer approves it", () => {
    const r = scan("custom-untrusted");
    expect(row(r)?.status).toBe("untrusted");
    expect(customFindings(r)).toEqual([]);
  });
  it("runs after trust --yes and reports its finding as custom:actionlint", () => {
    expect(run("custom-trust", dir, ["trust", "--yes"], { timeout: 180_000 }).status).toBe(0);
    const r = scan("custom-trusted");
    expect(row(r)?.status).toBe("ran");
    expect(customFindings(r)).toContain("custom:actionlint:expression");
  });
  it("stops running when its run line changes after approval", () => {
    writeConfig(dir, yaml(`${command} -verbose`));
    const r = scan("custom-changed");
    expect(row(r)?.status).toBe("untrusted");
    expect(customFindings(r)).toEqual([]);
  });
});
