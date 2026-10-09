// The repo config across versions, through the real built CLI in temp
// repos: what init writes, what an older version does with a newer file,
// and `openqodex config migrate`.
//
// Ways it could fail, written before the code:
//  1. init writes every default as a live value, so a later default change
//     never reaches the repo.
//  2. A scanner name a newer version added to scanners.disable stops an
//     older teammate's run with exit 2, which the push gate lets through.
//  3. A repo that needs a newer version cannot stop an older one, or the
//     line does not say which version it needs.
//  4. config migrate writes without --write, loses a comment, or leaves the
//     old key in place after --write.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { cli, sandbox } from "./init-helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const version = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;

function withConfig(text: string) {
  const s = sandbox({ "app.py": "print('hello')\n" });
  mkdirSync(join(s.repo, ".openqodex"));
  writeFileSync(join(s.repo, ".openqodex/config.yaml"), text);
  writeFileSync(join(s.repo, "app.py"), "print('changed')\n");
  return s;
}

describe("the repo config across versions", () => {
  it("init writes version: 1 and every other key as a comment (failure 1)", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const text = readFileSync(join(s.repo, ".openqodex/config.yaml"), "utf8");
    expect(parseYaml(text)).toEqual({ version: 1 });
    expect(text).toMatch(/^# +severity_threshold: minor$/m);
  });

  it("a scanner name this version does not know in scanners.disable gives one warning and the run goes on (failure 2)", () => {
    const s = withConfig("version: 1\nscanners:\n  disable: [snyk]\n");
    const r = cli(s, ["scan", "--no-install", "--offline", "--format", "json"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr.match(/scanners\.disable: snyk is not a scanner this version knows; it is ignored/g)).toHaveLength(1);
  });

  it("min_version above this version stops the run with exit 2 and the version it needs (failure 3)", () => {
    const s = withConfig("version: 1\nmin_version: 99.0.0\n");
    const r = cli(s, ["scan", "--no-install", "--offline", "--format", "json"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`.openqodex/config.yaml: min_version: this repo's config needs openqodex 99.0.0 or newer, and this is ${version}; run openqodex update`);
  });

  it("config migrate shows the rewrite and writes nothing; --write renames the key and keeps every comment (failure 4)", () => {
    const before = "# ours\npr_review: # the block\n  block_on_severity: major # firm\n";
    const s = withConfig(before);
    const preview = cli(s, ["config", "migrate"]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("pr_review renamed to review");
    expect(preview.stdout).toContain("Nothing was written.");
    expect(readFileSync(join(s.repo, ".openqodex/config.yaml"), "utf8")).toBe(before);
    const write = cli(s, ["config", "migrate", "--write"]);
    expect(write.status, write.stderr).toBe(0);
    expect(readFileSync(join(s.repo, ".openqodex/config.yaml"), "utf8")).toBe("# ours\nreview: # the block\n  block_on_severity: major # firm\n");
    expect(cli(s, ["config", "migrate"]).stdout).toContain("needs no change");
  });
});
