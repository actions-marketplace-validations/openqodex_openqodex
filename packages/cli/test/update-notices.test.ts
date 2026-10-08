// What the first command after an update says, and what doctor says about
// the last update, through the real built CLI and launcher in temp homes.
//
// Ways it could fail, written before the code:
//  1. After an update the next command names only the two versions, not a
//     change in what leaves the machine, what blocks a push or who reviews
//     (the 0.6.0 web default reached 0.5.0 installs without a word).
//  2. A release notice prints twice, or one outside the two versions prints.
//  3. After an update, files OpenQodex wrote that this version writes
//     differently go unmentioned, so an agent keeps an older procedure until
//     someone happens to run init; or a file the developer edited, which
//     init keeps, is counted.
//  4. doctor does not list the notices of the last update or the files
//     init would refresh.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTICES, noticesBetween } from "../src/notices.js";
import { cli, env, sandbox, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;

function launch(s: Sandbox, args: string[]) {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), ...args], { encoding: "utf8", env: env(s), cwd: s.repo, timeout: 120_000 });
}

function installed(agents: string[]): Sandbox {
  const s = sandbox();
  const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", ...agents.flatMap((a) => ["--agent", a])]);
  expect(r.status, r.stderr).toBe(0);
  return s;
}

// The notice a worker of 0.8.1 or earlier leaves after it switched: the two
// versions in its text, no `from` field.
function switchedFrom(s: Sandbox, from: string): void {
  writeFileSync(join(s.oqHome, "update.json"), `${JSON.stringify({ notice: { version, text: `openqodex updated to ${version} (was ${from}). Roll back: openqodex update --rollback` } })}\n`);
  writeFileSync(join(s.oqHome, "runtime/current"), `${version}\n${from}\n`);
}

// A user-scope file as an older init wrote it and recorded it.
function asOlder(s: Sandbox, path: string, text: string): void {
  writeFileSync(path, text);
  const record = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { files: { path: string; sha256: string }[] };
  for (const f of record.files) if (f.path === path) f.sha256 = createHash("sha256").update(text).digest("hex");
  writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(record, null, 2));
}

describe("after an update", () => {
  it("the next command prints every release notice after the old version, once, and none from before it (failures 1 and 2)", () => {
    const s = installed(["claude-code"]);
    switchedFrom(s, "0.5.0");
    const first = launch(s, ["guide", "config"]);
    const second = launch(s, ["guide", "config"]);
    expect(first.stderr).toContain(`openqodex updated to ${version} (was 0.5.0)`);
    const expected = noticesBetween("0.5.0", version);
    for (const n of expected) expect(first.stderr).toContain(`${n.version}: ${n.text}`);
    for (const n of NOTICES.filter((x) => !expected.includes(x))) expect(first.stderr).not.toContain(n.text);
    expect(second.stderr).not.toContain("openqodex updated");
    for (const n of NOTICES) expect(second.stderr).not.toContain(n.text);
  });

  it("names how many files OpenQodex wrote are from an older version, counting none the developer edited, and init refreshes them (failure 3)", () => {
    const s = installed(["claude-code", "cline"]);
    const skill = join(s.home, ".claude/skills/openqodex/SKILL.md");
    asOlder(s, skill, "---\nname: openqodex\ndescription: an older stub\n---\n\nRun the older procedure.\n");
    const rule = join(s.home, "Documents/Cline/Rules/openqodex.md");
    appendFileSync(rule, "\nMy own line.\n");
    switchedFrom(s, "0.5.0");
    const launcher = `'${join(s.oqHome, "bin/openqodex")}'`;
    const r = launch(s, ["guide", "config"]);
    expect(r.stderr).toContain(`1 file OpenQodex wrote is from an older version; run ${launcher} init to refresh them`);
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code", "--agent", "cline"]).status).toBe(0);
    expect(readFileSync(skill, "utf8")).toContain("guide skill");
    expect(readFileSync(rule, "utf8")).toContain("My own line.");
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/^agent files +up to date$/m);
  });
});

describe("doctor after an update", () => {
  it("lists the notices of the last update and the files init would refresh (failure 4)", () => {
    const s = installed(["claude-code"]);
    const skill = join(s.home, ".claude/skills/openqodex/SKILL.md");
    asOlder(s, skill, "an older stub\n");
    writeFileSync(join(s.oqHome, "runtime/current"), `${version}\n0.5.0\n`);
    const r = launch(s, ["doctor"]);
    for (const n of noticesBetween("0.5.0", version)) expect(r.stdout).toContain(`notice       ${n.version}: ${n.text}`);
    expect(r.stdout).toMatch(/^ {2}agent files +1 OpenQodex wrote is from an older version; run .* init to refresh them$/m);
  });
});
