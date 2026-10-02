// `openqodex init`, run as the real built CLI in temp homes and temp repos.
//
// Ways it could fail, written before the code:
//  1. A user-scope install changes the repo's `git status` (the Cursor rule is
//     not excluded, or something else lands in the work tree).
//  2. A second run rewrites a file, adds a second hook entry, or appends the
//     exclude line again.
//  3. Merging into an existing settings.json drops other keys or other hooks.
//  4. A settings file that does not parse is rewritten or truncated, or init
//     exits 0 as if all went well.
//  5. The hook command breaks when the home folder path holds a space
//     (unquoted path through a shell).
//  6. The launcher points at a runtime that does not run.
//  7. A file that a JSON file says is written is not valid JSON.
//  8. `--project` writes to the home folder, or still uses the absolute
//     launcher path in files a team would commit.
//  9. `--uninstall` leaves our entries behind, removes the developer's own
//     entries, or does not put an existing file back as it was.
// 10. `--dry-run` writes something.
// 11. Without a terminal and without --yes, init writes without asking.
// 12. A foreign rule or skill file with the same name is overwritten.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BIN, cli, env, sandbox, snapshot, status, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;

function userFiles(s: Sandbox): string[] {
  return [
    join(s.home, ".claude/skills/openqodex/SKILL.md"),
    join(s.home, ".claude/settings.json"),
    join(s.home, ".agents/skills/openqodex/SKILL.md"),
    join(s.home, ".codex/hooks.json"),
    join(s.home, ".cursor/skills/openqodex/SKILL.md"),
    join(s.repo, ".cursor/rules/openqodex.mdc"),
    join(s.home, ".cline/skills/openqodex/SKILL.md"),
    join(s.home, "Documents/Cline/Rules/openqodex.md"),
    join(s.oqHome, "bin/openqodex"),
    join(s.oqHome, "runtime", version, "dist/bin.js"),
  ];
}

function hookCommand(settingsPath: string): string {
  const data = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };
  const commands = data.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes("hook check"));
  expect(commands).toHaveLength(1);
  return commands[0];
}

describe("openqodex init, user scope", () => {
  let s: Sandbox;
  let statusBefore: string;
  let first: ReturnType<typeof cli>;

  beforeAll(() => {
    expect(existsSync(BIN), "build the CLI first (pnpm build)").toBe(true);
    s = sandbox();
    statusBefore = status(s);
    first = cli(s, ["init", "--yes", "--agent", "all"]);
  });

  it("writes every user-scope file and exits 0", () => {
    expect(first.status, first.stderr).toBe(0);
    for (const f of userFiles(s)) expect(existsSync(f), f).toBe(true);
    for (const f of [join(s.home, ".claude/settings.json"), join(s.home, ".codex/hooks.json")]) {
      expect(() => JSON.parse(readFileSync(f, "utf8"))).not.toThrow();
    }
    expect(first.stdout).toContain("review my change with openqodex");
    expect(first.stdout).toContain("/hooks");
    expect(first.stdout).toContain("init --uninstall");
    expect(first.stdout).toContain("hook install");
  });

  it("leaves the repo's git status unchanged", () => {
    expect(status(s)).toBe(statusBefore);
  });

  it("writes a launcher that runs the runtime copy", () => {
    const launcher = join(s.oqHome, "bin/openqodex");
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    const r = spawnSync(launcher, ["--version"], { encoding: "utf8", env: env(s) });
    expect(r.stdout.trim()).toBe(version);
  });

  it("writes hook commands that call the launcher by quoted absolute path and run through sh", () => {
    for (const f of [join(s.home, ".claude/settings.json"), join(s.home, ".codex/hooks.json")]) {
      const command = hookCommand(f);
      expect(command).not.toContain("npx");
      expect(command).toContain(join(s.oqHome, "bin/openqodex"));
      const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: s.repo });
      const r = spawnSync("sh", ["-c", command], { input, encoding: "utf8", env: env(s), cwd: s.repo });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("OpenQodex has not reviewed this change");
    }
  });

  it("changes nothing on a second run and says so", () => {
    const before = snapshot(s);
    const second = cli(s, ["init", "--yes", "--agent", "all"]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Nothing to change");
    expect(snapshot(s)).toEqual(before);
  });

  it("--uninstall removes what it wrote and restores the starting state", () => {
    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    for (const f of userFiles(s)) expect(existsSync(f), f).toBe(false);
    expect(readFileSync(join(s.repo, ".git/info/exclude"), "utf8")).not.toContain("openqodex");
    expect(status(s)).toBe(statusBefore);
    expect(Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"))).toEqual([]);
  });
});

describe("openqodex init, existing files", () => {
  it("keeps other keys and hooks in an existing settings.json, and uninstall puts it back byte for byte", () => {
    const s = sandbox();
    const settings = join(s.home, ".claude/settings.json");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    const original =
      '{\n    "model": "x",\n    "hooks": {\n        "PreToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "echo mine"}]}],\n        "Stop": [{"hooks": [{"type": "command", "command": "echo stop"}]}]\n    }\n}\n';
    writeFileSync(settings, original);

    const r = cli(s, ["init", "--yes", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    const merged = JSON.parse(readFileSync(settings, "utf8"));
    expect(merged.model).toBe("x");
    expect(merged.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo stop" }] }]);
    expect(merged.hooks.PreToolUse[0]).toEqual({ matcher: "Edit", hooks: [{ type: "command", command: "echo mine" }] });
    expect(merged.hooks.PreToolUse[1].matcher).toBe("Bash");
    expect(merged.hooks.PreToolUse[1].hooks[0].if).toBe("Bash(git push*)");
    expect(readFileSync(`${settings}.openqodex.bak`, "utf8")).toBe(original);

    const u = cli(s, ["init", "--uninstall", "--yes", "--agent", "claude-code"]);
    expect(u.status, u.stderr).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(existsSync(`${settings}.openqodex.bak`)).toBe(false);
  });

  it("leaves a settings file that does not parse byte-identical, installs the rest, and exits 2", () => {
    const s = sandbox();
    const settings = join(s.home, ".claude/settings.json");
    mkdirSync(join(s.home, ".claude"), { recursive: true });
    writeFileSync(settings, "{ not json,\n");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "codex"]);
    expect(r.status).toBe(2);
    expect(readFileSync(settings, "utf8")).toBe("{ not json,\n");
    expect(existsSync(join(s.home, ".codex/hooks.json"))).toBe(true);
    expect(existsSync(join(s.home, ".claude/skills/openqodex/SKILL.md"))).toBe(true);
  });

  it("does not overwrite a foreign rule file with the same name", () => {
    const s = sandbox();
    const rule = join(s.home, "Documents/Cline/Rules/openqodex.md");
    mkdirSync(join(rule, ".."), { recursive: true });
    writeFileSync(rule, "my own rule\n");
    const r = cli(s, ["init", "--yes", "--agent", "cline"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(rule, "utf8")).toBe("my own rule\n");
    expect(r.stdout).toContain("left alone");
    cli(s, ["init", "--uninstall", "--yes", "--agent", "cline"]);
    expect(readFileSync(rule, "utf8")).toBe("my own rule\n");
  });
});

describe("openqodex init, project scope", () => {
  it("writes the project paths with npx commands, and uninstall leaves git status as it was", () => {
    const s = sandbox({ "README.md": "hello\n", "AGENTS.md": "# Agents\n\nBe nice.\n" });
    const r = cli(s, ["init", "--yes", "--project", "--agent", "all"]);
    expect(r.status, r.stderr).toBe(0);
    for (const p of [
      ".claude/skills/openqodex/SKILL.md",
      ".claude/settings.json",
      ".agents/skills/openqodex/SKILL.md",
      ".codex/hooks.json",
      ".cursor/rules/openqodex.mdc",
      ".cline/skills/openqodex/SKILL.md",
      ".clinerules/openqodex.md",
    ]) {
      expect(existsSync(join(s.repo, p)), p).toBe(true);
    }
    const agentsMd = readFileSync(join(s.repo, "AGENTS.md"), "utf8");
    expect(agentsMd.startsWith("# Agents\n\nBe nice.\n")).toBe(true);
    expect(agentsMd).toContain("<!-- openqodex:start -->");
    expect(hookCommand(join(s.repo, ".claude/settings.json"))).toBe(`npx -y openqodex@${version} hook check`);
    expect(Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"))).toEqual([]);
    expect(readFileSync(join(s.repo, ".git/info/exclude"), "utf8")).not.toContain("openqodex");

    const again = cli(s, ["init", "--yes", "--project", "--agent", "all"]);
    expect(again.stdout).toContain("Nothing to change");

    const u = cli(s, ["init", "--uninstall", "--yes", "--project"]);
    expect(u.status, u.stderr).toBe(0);
    expect(status(s)).toBe("");
  });
});

describe("openqodex init, no writes", () => {
  it("--dry-run prints the plan and writes nothing", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = cli(s, ["init", "--dry-run", "--agent", "all"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(join(s.home, ".claude/settings.json"));
    expect(snapshot(s)).toEqual(before);
  });

  it("without a terminal and without --yes prints the plan and exits 2", () => {
    const s = sandbox();
    const before = snapshot(s);
    const r = cli(s, ["init", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--yes");
    expect(snapshot(s)).toEqual(before);
  });

  it("an unknown agent is a usage error", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--agent", "vim"]).status).toBe(2);
  });
});
