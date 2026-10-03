// The repo folder's team files and the owners' instructions, run as the real
// built CLI in temp homes and temp repos.
//
// Ways it could fail, written before the code:
//  1. Init or the first scan does not create config.yaml or
//     custom-instructions.md, or rewrites one the team edited.
//  2. A config.yaml is created beside a root .openqodex.yaml, so the team
//     has two config files and no word about which one is read.
//  3. The instructions reach the brief changed, cut, or not at all.
//  4. Finalize accepts a review whose instructions changed after the brief.
//  5. An instructions file over the limit is cut instead of refused.
//  6. A review by the agent that wrote the code is reported as independent,
//     or a new run finalizes without saying who reviewed.
//  7. Init replaces a team file another first run created after init made
//     its plan, and records it as its own.
//  8. Uninstall deletes a Day 0 .gitignore that init only migrated.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planRepoFiles } from "../src/agents/repo-folder.js";
import { emptyRecord } from "../src/agents/record.js";
import { cli, sandbox, type Sandbox } from "./init-helpers.js";

const CONFIG = ".openqodex/config.yaml";
const INSTRUCTIONS = ".openqodex/custom-instructions.md";

function read(s: Sandbox, path: string): string {
  return readFileSync(join(s.repo, path), "utf8");
}

function latest(s: Sandbox): { dir: string; change_id: string } {
  return JSON.parse(read(s, ".openqodex/latest.json")) as { dir: string; change_id: string };
}

function submit(s: Sandbox, extra: Record<string, unknown> = {}): void {
  const run = latest(s);
  const findings = { version: 1, change_id: run.change_id, summary: "Checked.", reviewer: "subagent", findings: [], ...extra };
  writeFileSync(join(s.repo, run.dir, "agent-findings.json"), JSON.stringify(findings));
}

describe("the repo folder's team files", () => {
  it("init and the first scan create both files, and never touch one the team edited", () => {
    const s = sandbox({ "README.md": "hello\n" });
    const r = cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Commit ${CONFIG} and ${INSTRUCTIONS}`);
    const editedConfig = `${read(s, CONFIG)}# ours\n`;
    writeFileSync(join(s.repo, CONFIG), editedConfig);
    writeFileSync(join(s.repo, INSTRUCTIONS), "Never flag the vendored code.\n");

    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    expect(cli(s, ["scan", "--no-install"]).status).toBe(0);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(read(s, CONFIG)).toBe(editedConfig);
    expect(read(s, INSTRUCTIONS)).toBe("Never flag the vendored code.\n");
  });

  it("the first scan in a repo creates both files and says to commit them", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const r = cli(s, ["scan", "--no-install"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.repo, CONFIG))).toBe(true);
    expect(existsSync(join(s.repo, INSTRUCTIONS))).toBe(true);
    expect(r.stderr).toContain("Commit them");
  });

  it("creates no config.yaml while a root .openqodex.yaml exists, and says the root file is still read", () => {
    const s = sandbox({ ".openqodex.yaml": "review:\n  block_on_severity: major\n" });
    const r = cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.repo, CONFIG))).toBe(false);
    expect(existsSync(join(s.repo, INSTRUCTIONS))).toBe(true);
    expect(r.stdout).toContain(".openqodex.yaml at its root; it is still read");
  });
});

describe("the owners' instructions in the review", () => {
  it("reach the brief word for word, and finalize refuses a run whose instructions changed", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const text = "Our handlers validate input in middleware: never flag a missing check in a handler.\nAlways check that every new endpoint has a rate limit.";
    expect(cli(s, ["scan", "--no-install"]).status).toBe(0);
    writeFileSync(join(s.repo, INSTRUCTIONS), `${text}\n`);

    const brief = cli(s, ["review", "--agent", "--no-install"]);
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.stdout).toContain(text);
    submit(s);
    writeFileSync(join(s.repo, INSTRUCTIONS), `${text}\nAnd one more rule.\n`);
    const r = cli(s, ["review", "--finalize"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("the instructions changed");
  });

  it("a file over 32 KB stops the review with a plain message, nothing cut", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    expect(cli(s, ["scan", "--no-install"]).status).toBe(0);
    writeFileSync(join(s.repo, INSTRUCTIONS), "x".repeat(33 * 1024));
    const r = cli(s, ["review", "--agent", "--no-install"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("over the 32 KB limit");
    expect(r.stdout).toBe("");
  });

  it("a review by the agent that wrote the code says so on the summary's first line", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    expect(cli(s, ["review", "--agent", "--no-install"]).status).toBe(0);
    submit(s, { reviewer: "same-agent" });
    expect(cli(s, ["review", "--finalize"]).status).toBe(0);
    const report = JSON.parse(read(s, join(latest(s).dir, "report.json"))) as { summary: string };
    expect(report.summary.split("\n")[0]).toBe("Not an independent review: the agent that wrote the code reviewed it.");
  });
});

describe("ownership of the team files", () => {
  it("init never replaces a team file created after it made its plan, and does not record it", async () => {
    const s = sandbox();
    const record = emptyRecord();
    const { actions } = planRepoFiles(s.repo, record);
    mkdirSync(join(s.repo, ".openqodex"), { recursive: true });
    writeFileSync(join(s.repo, INSTRUCTIONS), "Written by a first scan in another terminal.\n");
    for (const a of actions) await a.apply?.();
    expect(read(s, INSTRUCTIONS)).toBe("Written by a first scan in another terminal.\n");
    expect(record.files.map((f) => f.path)).not.toContain(join(s.repo, INSTRUCTIONS));
    expect(record.files.map((f) => f.path)).toContain(join(s.repo, CONFIG));
  });

  it("uninstall gives a migrated Day 0 .gitignore its original bytes back", () => {
    const s = sandbox();
    mkdirSync(join(s.repo, ".openqodex"));
    writeFileSync(join(s.repo, ".openqodex/.gitignore"), "*\n");
    expect(cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]).status).toBe(0);
    expect(read(s, ".openqodex/.gitignore")).not.toBe("*\n");
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(read(s, ".openqodex/.gitignore")).toBe("*\n");
  });
});

describe("who reviewed", () => {
  it("a new run without reviewer is refused by finalize, and the brief shows the field", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const brief = cli(s, ["review", "--agent", "--no-install"]);
    expect(brief.stdout).toContain('"reviewer": "subagent"');
    const run = latest(s);
    writeFileSync(join(s.repo, run.dir, "agent-findings.json"), JSON.stringify({ version: 1, change_id: run.change_id, summary: "Checked.", findings: [] }));
    const r = cli(s, ["review", "--finalize"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("reviewer");
  });
});
