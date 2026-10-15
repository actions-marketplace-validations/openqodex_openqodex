// Ways the combined reviewer check could fail, written before the code:
// 1. A replacement hunk never selects the shipped replacement lens in the brief.
// 2. The reviewer receives the old omission rule instead of honest confidence.
// 3. A harmless replacement in the demo's clean copy produces a new finding.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import { baseline, readBrief, readJson, reportDir, root, run } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

describe("replacement lens and honest confidence in a CLI review", () => {
  let brief: string;
  let reviewed: Report;

  beforeAll(() => {
    const dir = baseline();
    const file = join(dir, "app/server.py");
    // Parentheses preserve the value, so this replacement loses no effect.
    writeFileSync(file, readFileSync(file, "utf8").replace("PAGE_SIZE = 20", "PAGE_SIZE = (20)"));
    const args = ["review", "--base", "HEAD", "--skip", "semgrep,osv-scanner", "--no-graph", "--offline", "--no-install", "--no-color"];
    const prepared = run("replacement-confidence-prepare", dir, [...args, "--agent"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const change = readBrief(dir);
    expect(change.candidates).toEqual([]);

    // Replay an empty answer through the model provider used by the e2e suite.
    const provider = tempDir("oq-e2e-replacement-provider-");
    writeFileSync(join(provider, "claude"), `#!${process.execPath}\n${readFileSync(join(root, "tests/golden/stand-ins/claude.cjs"), "utf8")}`);
    chmodSync(join(provider, "claude"), 0o755);
    writeFileSync(join(provider, "submission.json"), JSON.stringify({ version: 2, change_id: change.changeId, summary: "Preserves the page size.", findings: [], dropped: [] }));
    const result = run("replacement-confidence-review", dir, [...args, "--reviewer", "claude", "--reviewer-web", "off"], {
      env: { PATH: [provider, dirname(process.execPath), process.env.PATH].join(delimiter), CLAUDECODE: undefined },
    });
    expect(result.status, result.stderr).toBe(0);
    const out = reportDir(dir);
    reviewed = readJson<Report>(join(out, "report.json"));
    expect(reviewed.completion?.status).toBe("complete");
    brief = readFileSync(join(out, "brief.md"), "utf8");
  });

  it("does not omit the replacement lens from the reviewer brief", () => {
    expect(brief).toContain("### replaced-line-drops-behavior");
  });

  it("does not replace honest confidence with the old omission rule", () => {
    expect(brief).toContain("Raise every defect you can show from the code with confidence 0.7 or higher. Set confidence honestly; the floor removes the rest.");
  });

  it("does not add a finding for a harmless replacement in the clean demo", () => {
    expect(reviewed.findings).toEqual([]);
  });
});
