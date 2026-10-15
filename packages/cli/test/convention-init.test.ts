// Failure cases: unattended init chooses files; a terminal choice is lost;
// a review with an empty choice repeats the hint or reads the candidates.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";
import { cli, inTerminal, sandbox } from "./init-helpers.js";
import { conventionHint } from "../src/instructions.js";

afterAll(removeTempDirs);

describe("init convention choices", () => {
  it.each(["cursor", "cline"])("does not offer the tool's own rules after a project install for %s", (agent) => {
    const s = sandbox();
    const got = cli(s, ["init", "--project", "--agent", agent, "--yes", "--no-mcp", "--hook", "none"]);
    expect(got.status, got.stderr).toBe(0);
    expect(conventionHint(s.repo)).toBeNull();
  });

  it("does not rewrite or reorder existing convention choices when init is repeated", () => {
    const text = "review:\n  instructions_files: [AGENTS.md, docs/*.md, CONTRIBUTING.md]\n";
    const s = sandbox({ "AGENTS.md": "First rule.\n", "CONTRIBUTING.md": "Last rule.\n", ".openqodex/config.yaml": text });
    const path = join(s.repo, ".openqodex/config.yaml");
    const before = statSync(path, { bigint: true });
    for (let i = 0; i < 2; i++) {
      const got = inTerminal(s, ["init", "--project", "--agent", "codex", "--no-mcp", "--hook", "none"], [
        ["Which convention files may the reviewer use?", "\r"],
        ["Write these files?", "\r"],
      ]);
      expect(got.status, got.stderr + got.stdout).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    }
  });

  it("does not choose files during an unattended init", () => {
    const s = sandbox({ "CONTRIBUTING.md": "Chosen only by a person.\n" });
    const got = cli(s, ["init", "--project", "--agent", "codex", "--yes", "--no-mcp", "--hook", "none"]);
    expect(got.status, got.stderr).toBe(0);
    expect(got.stdout).toContain("CONTRIBUTING.md (25 bytes)");
    expect(got.stdout).toContain("review.instructions_files");
    const config = parse(readFileSync(join(s.repo, ".openqodex/config.yaml"), "utf8"));
    expect(config.review?.instructions_files).toBeUndefined();
  });

  it("persists only the convention files selected in the terminal", () => {
    const s = sandbox({ "CONTRIBUTING.md": "Rule.\n", "AGENTS.md": "Other rule.\n" });
    const got = inTerminal(s, ["init", "--project", "--agent", "codex", "--no-mcp", "--hook", "none"], [
      ["Which convention files may the reviewer use?", " \r"],
      ["Write these files?", "\r"],
    ]);
    expect(got.status, got.stderr + got.stdout).toBe(0);
    const config = parse(readFileSync(join(s.repo, ".openqodex/config.yaml"), "utf8"));
    expect(config.review.instructions_files).toEqual(["CONTRIBUTING.md"]);
  });

  it("prints one hint without supplying unchosen candidate contents", () => {
    const s = sandbox({ "CONTRIBUTING.md": "UNCHOSEN-CANARY\n", "readme.txt": "Before\n" });
    writeFileSync(join(s.repo, "readme.txt"), "After\n");
    const got = cli(s, ["review", "--agent", "--offline", "--only", "sqllint", "--no-graph"]);
    expect(got.status, got.stderr).toBe(0);
    expect(got.stderr.match(/Convention files available:/g)).toHaveLength(1);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8"));
    const brief = readFileSync(join(s.repo, latest.dir, "brief.md"), "utf8");
    expect(brief).not.toContain("UNCHOSEN-CANARY");
    expect(brief).not.toContain("## Conventions chosen");
  });
});
