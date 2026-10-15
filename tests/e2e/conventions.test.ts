// Real CLI failure cases: a chosen convention is absent from the saved
// brief; unsafe files reach it; omissions disappear from the receipt;
// finalize accepts changed rules; an unadmitted file invalidates binding;
// report-dir reads work tree rules; a commit flag reads head's work tree.
// The model provider alone is a stand-in.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";
import { BIN, cli, env, git, sandbox } from "../../packages/cli/test/init-helpers.js";

afterAll(removeTempDirs);

function fixture() {
  const s = sandbox({ "README.md": "# Demo service\n", "app/server.py": "def page_size():\n    return 10\n" });
  writeFileSync(join(s.repo, "app/server.py"), "def page_size():\n    return 20\n");
  mkdirSync(join(s.repo, ".openqodex"));
  writeFileSync(join(s.repo, ".openqodex/config.yaml"), 'review:\n  instructions_files: [CONTRIBUTING.md, docs/style.md, missing.md, linked.md, folder, ../outside.md, big.md, full-a.md, full-b.md]\n  paths:\n    exclude: ["*.md", "docs/**", "folder/**", ".openqodex/**"]\n');
  writeFileSync(join(s.repo, ".openqodex/custom-instructions.md"), "Owners' instructions.\n");
  writeFileSync(join(s.repo, "CONTRIBUTING.md"), "Use parameter names from the public API.\n");
  mkdirSync(join(s.repo, "docs"));
  writeFileSync(join(s.repo, "docs/style.md"), "Keep calls explicit.\n");
  symlinkSync("CONTRIBUTING.md", join(s.repo, "linked.md"));
  mkdirSync(join(s.repo, "folder"));
  writeFileSync(join(s.repo, "big.md"), "x".repeat(32769));
  for (const name of ["full-a.md", "full-b.md"]) writeFileSync(join(s.repo, name), "y".repeat(32768));
  return s;
}

function latest(s: ReturnType<typeof sandbox>): string {
  return join(s.repo, JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")).dir);
}
function answer(dir: string): void {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  writeFileSync(join(dir, "agent-findings.json"), JSON.stringify({ version: 1, change_id: manifest.change_id.slice(0, 12), reviewer: "subagent", summary: "Changes the page size.", findings: [], dropped: [] }));
}

const agentArgs = ["review", "--agent", "--offline", "--only", "sqllint", "--no-graph"];

describe("conventions in the real CLI", () => {
  it("keeps omitted files out of the brief and warns in the receipt without blocking", () => {
    const s = fixture();
    const prepared = cli(s, agentArgs);
    expect(prepared.status, prepared.stderr).toBe(0);
    const dir = latest(s);
    const brief = readFileSync(join(dir, "brief.md"), "utf8");
    expect(brief).toContain("> From: CONTRIBUTING.md");
    expect(brief).toContain("> From: docs/style.md");
    for (const name of ["missing.md", "linked.md", "folder", "../outside.md", "big.md", "full-b.md"]) expect(brief).not.toContain(`> From: ${name}`);
    answer(dir);
    const done = cli(s, ["review", "--finalize", "--offline"]);
    expect(done.status, done.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    for (const name of ["missing.md", "linked.md", "folder", "../outside.md", "big.md", "full-b.md"]) {
      expect(report.notes.filter((note: string) => note.startsWith(`Convention omitted: ${name} `))).toHaveLength(1);
      expect(done.stdout.split("\n").filter((line) => line.startsWith(`Convention omitted: ${name} `))).toHaveLength(1);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.instruction_files.filter((file: { omitted: string | null }) => file.omitted === null).map((file: { path: string }) => file.path)).toEqual(["CONTRIBUTING.md", "docs/style.md", "full-a.md"]);
    expect(report.notes.join("\n")).toContain("Conventions supplied:");
    expect(readFileSync(join(dir, "report.sarif"), "utf8")).toContain("Convention omitted: linked.md");
  });

  it("refuses an edited admitted rule but does not bind an ignored skipped file", () => {
    const s = fixture();
    // Keep both edits outside the change id so only the instructions binding is tested.
    writeFileSync(join(s.repo, ".gitignore"), "big.md\nCONTRIBUTING.md\n");
    expect(git(s.repo, "check-ignore", "big.md", "CONTRIBUTING.md").trim().split("\n")).toEqual(["big.md", "CONTRIBUTING.md"]);
    expect(cli(s, agentArgs).status).toBe(0);
    const dir = latest(s);
    answer(dir);
    writeFileSync(join(s.repo, "big.md"), "Now small.\n");
    const accepted = cli(s, ["review", "--finalize", "--offline"]);
    expect(accepted.status, accepted.stderr).toBe(0);
    writeFileSync(join(s.repo, "CONTRIBUTING.md"), "Changed rule.\n");
    const refused = cli(s, ["review", "--finalize", "--offline"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("CONTRIBUTING.md changed since the brief");
  });

  it("reads chosen rules from commit objects only when report-dir has an explicit source", () => {
    const s = sandbox({ "README.md": "# Demo\n", "rules.md": "COMMITTED-CONVENTION\n", "app/server.py": "def page_size():\n    return 10\n" });
    const source = git(s.repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(s.repo, "rules.md"), "WORKTREE-CONVENTION\n");
    writeFileSync(join(s.repo, "app/server.py"), "def page_size():\n    return 20\n");
    const config = join(s.root, "config.yaml");
    writeFileSync(config, 'review:\n  instructions_files: [rules.md]\n');
    const provider = tempDir("oq-convention-provider-");
    const program = join(provider, "claude");
    writeFileSync(program, `#!${process.execPath}\n${readFileSync(new URL("./fixtures/convention-provider.cjs", import.meta.url), "utf8")}`);
    chmodSync(program, 0o755);
    for (const ref of [undefined, "none", source]) {
      const report = tempDir("oq-convention-report-");
      const result = spawnSync(process.execPath, [BIN, "review", "--only", "sqllint", "--no-graph", "--offline", "--reviewer", "claude", "--config", config, "--report-dir", report, ...(ref ? ["--instructions-ref", ref] : [])], { cwd: s.repo, env: env(s, { PATH: `${provider}:${env(s).PATH}` }), encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      const brief = readFileSync(join(report, "brief.md"), "utf8");
      const block = brief.includes("## Conventions chosen") ? brief.slice(brief.indexOf("## Conventions chosen"), brief.indexOf("## Scanner candidates")) : "";
      expect(block).not.toContain("WORKTREE-CONVENTION");
      if (ref === source) expect(block).toContain("COMMITTED-CONVENTION");
      else expect(block).toBe("");
    }
  });
});
