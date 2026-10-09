// `openqodex init` registering the code graph's MCP server, named
// openqodex, with each agent, run as the real built CLI in temp homes whose
// paths hold a space.
//
// Ways it could fail, written before the code:
//  1. An agent's MCP file is written where or in a shape the agent does not
//     read: another path or key, a command in shell quotes (an entry's
//     command runs without a shell), or a JSON or TOML string that a home
//     path holding a space or a double quote breaks.
//  2. Claude Code's user-scope server goes inside ~/.claude instead of into
//     ~/.claude.json, or into ~/.claude.json while CLAUDE_CONFIG_DIR names
//     the folder Claude Code reads.
//  3. A second init rewrites an MCP file or adds a second entry.
//  4. A merge drops or reorders a server or a key of the developer's, or a
//     Codex config.toml that does not end with a newline gets the block
//     glued to its last line.
//  5. A file that does not parse, or whose mcpServers is not an object, is
//     rewritten.
//  6. A server named openqodex that init did not write is replaced; in
//     Codex's config.toml a second definition is appended, in any spelling
//     of the key, which makes Codex refuse the whole file.
//  7. Uninstall leaves our entry or block, removes a server or a line of
//     the developer's, leaves a file init created, or does not put the
//     developer's file back byte for byte.
//  8. --no-mcp writes a registration, leaves one an earlier init recorded,
//     or a later --yes adds it back; --mcp does not bring it back; the plan
//     does not name the opt-out.
//  9. --project writes the launcher path, which a teammate's machine does
//     not have, instead of the pinned npx form; or writes a Cline file Cline
//     does not document.
// 10. Cline's CLI file is written when only the VS Code extension is there
//     (it reads another file), or the ~/.cline folder init makes for the
//     skill makes a second init register the server.
// 11. The Claude Code permission rules miss the graph command, or grant
//     anything for the MCP server's tools.
// 12. Claude Code rewrites ~/.claude.json while it runs: init refuses for a
//     change it does not touch, or overwrites a change Claude Code made.
// 13. A rule lets Claude Code run the tools of a server named openqodex
//     without asking. A rule names a server by its name only, so it also
//     covers a project or local server of that name that is not
//     OpenQodex's, which init cannot see from the user scope; or the rule
//     an earlier build recorded stays.
// 14. Codex's config.toml defines the server in a spelling a pattern does
//     not see (quoted, escaped, spaced or as an array of tables), and init
//     appends a second one, which makes Codex refuse the whole file; or text
//     inside a string is taken for a definition; or a file that is not TOML
//     gets a block appended.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BIN, cli, inTerminal, sandbox, snapshot, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;

// What a user-scope init writes as the server's command: the launcher by its
// full path, unquoted.
const launcher = (s: Sandbox): string => join(s.oqHome, "bin", "openqodex");
const PINNED = ["-y", `openqodex@${version}`, "mcp"];

function stdio(command: string, args: string[]): Record<string, unknown> {
  return { type: "stdio", command, args };
}

// A JSON MCP file as init writes it: two-space indent and a final newline.
function jsonFile(servers: Record<string, unknown>, rest: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...rest, mcpServers: servers }, null, 2)}\n`;
}

// Codex's block. A TOML basic string escapes `"`, `\` and control
// characters the way JSON does, so JSON.stringify spells the expected
// string independently of the code under test.
function tomlBlock(command: string, args: string[]): string {
  return ["# openqodex:start", "[mcp_servers.openqodex]", `command = ${JSON.stringify(command)}`, `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`, "# openqodex:end", ""].join("\n");
}

// A real TOML parser, Python's tomllib, reading the file as Codex would:
// it fails on a duplicate table as Codex does.
function parseToml(path: string): Record<string, unknown> {
  const python = (process.env.PATH ?? "").split(delimiter).map((d) => join(d, "python3")).find((p) => existsSync(p));
  if (python === undefined) throw new Error("python3 is needed to parse TOML");
  const r = spawnSync(python, ["-I", "-c", "import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", path], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tomllib: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// Files under the home folder, the snapshot keys init.test.ts uses.
function homeFiles(s: Sandbox): string[] {
  return Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"));
}

const clineData = (s: Sandbox): string => join(s.home, ".cline", "data");
const clineFile = (s: Sandbox): string => join(clineData(s), "settings", "cline_mcp_settings.json");
const QUIET = ["--hook", "none", "--no-repo"];

describe("1, 2 and 10. each agent's MCP file on a fresh home, byte for byte", () => {
  it("1 and 2. Claude Code: ~/.claude.json in the home folder, a stdio entry running the launcher by its path", () => {
    const s = sandbox();
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(s.home, ".claude.json"))).toBe(jsonFile({ openqodex: stdio(launcher(s), ["mcp"]) }));
    expect(statSync(join(s.home, ".claude.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(s.home, ".claude", ".claude.json"))).toBe(false);
    // An agent reads its MCP servers when it starts.
    expect(r.stdout).toContain("Restart Claude Code to load the code graph's MCP server.");
  });

  it("2. Claude Code with CLAUDE_CONFIG_DIR: .claude.json in that folder, nothing in the home folder", () => {
    const s = sandbox();
    const config = join(s.root, "claude config");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", ...QUIET], { env: { CLAUDE_CONFIG_DIR: config } });
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(config, ".claude.json"))).toBe(jsonFile({ openqodex: stdio(launcher(s), ["mcp"]) }));
    expect(existsSync(join(s.home, ".claude.json"))).toBe(false);
  });

  it("1. Cursor: ~/.cursor/mcp.json", () => {
    const s = sandbox();
    const r = cli(s, ["init", "--yes", "--agent", "cursor", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(join(s.home, ".cursor", "mcp.json"))).toBe(jsonFile({ openqodex: stdio(launcher(s), ["mcp"]) }));
  });

  it("1. Codex: a marked block in $CODEX_HOME/config.toml that a TOML parser reads as the server", () => {
    const s = sandbox();
    const codexHome = join(s.root, "codex home");
    for (const [extra, file] of [[{}, join(s.home, ".codex", "config.toml")], [{ CODEX_HOME: codexHome }, join(codexHome, "config.toml")]] as const) {
      const r = cli(s, ["init", "--yes", "--agent", "codex", ...QUIET], { env: extra });
      expect(r.status, r.stderr).toBe(0);
      expect(read(file)).toBe(tomlBlock(launcher(s), ["mcp"]));
      expect(parseToml(file)).toEqual({ mcp_servers: { openqodex: { command: launcher(s), args: ["mcp"] } } });
    }
  });

  it("10. Cline: with the Cline CLI's data folder, its cline_mcp_settings.json gets the entry", () => {
    const s = sandbox();
    mkdirSync(clineData(s), { recursive: true });
    const r = cli(s, ["init", "--yes", "--agent", "cline", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(clineFile(s))).toBe(jsonFile({ openqodex: { command: launcher(s), args: ["mcp"] } }));
  });

  it("10. Cline: without the CLI's data folder, no MCP file and a note with the command; the ~/.cline init made for the skill does not change a second run", () => {
    const s = sandbox();
    const first = cli(s, ["init", "--yes", "--agent", "cline", ...QUIET]);
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(clineData(s))).toBe(false);
    expect(first.stdout).toContain("Configure MCP Servers");
    expect(first.stdout).toContain(launcher(s));
    expect(existsSync(join(s.home, ".cline", "skills", "openqodex", "SKILL.md"))).toBe(true);
    const before = snapshot(s);
    const second = cli(s, ["init", "--yes", "--agent", "cline", ...QUIET]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Nothing to change");
    expect(snapshot(s)).toEqual(before);
  });

  // Not a backslash: Node refuses to start a script whose path holds one
  // (ERR_INVALID_MODULE_SPECIFIER), so no launcher can live there.
  it("1. a home path holding a double quote survives in the JSON and in the TOML", () => {
    const s = sandbox({}, 'oq "q ');
    expect(launcher(s)).toContain('"');
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "codex", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    const claude = JSON.parse(read(join(s.home, ".claude.json"))) as { mcpServers: { openqodex: { command: string } } };
    expect(claude.mcpServers.openqodex.command).toBe(launcher(s));
    expect(parseToml(join(s.home, ".codex", "config.toml"))).toEqual({ mcp_servers: { openqodex: { command: launcher(s), args: ["mcp"] } } });
  });
});

describe("3 and 7. a second init, then uninstall, on a home with every agent", () => {
  let s: Sandbox;
  beforeAll(() => {
    s = sandbox();
    mkdirSync(clineData(s), { recursive: true });
    const r = cli(s, ["init", "--yes", "--agent", "all"]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("3. a second init changes no file", () => {
    const before = snapshot(s);
    const r = cli(s, ["init", "--yes", "--agent", "all"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Nothing to change");
    expect(snapshot(s)).toEqual(before);
  });

  it("7. uninstall removes every MCP file init created and leaves no file in the home folder", () => {
    for (const f of [join(s.home, ".claude.json"), join(s.home, ".cursor", "mcp.json"), join(s.home, ".codex", "config.toml"), clineFile(s)]) expect(existsSync(f), f).toBe(true);
    const r = cli(s, ["init", "--uninstall", "--yes"]);
    expect(r.status, r.stderr).toBe(0);
    expect(homeFiles(s)).toEqual([]);
  });
});

describe("4 and 7. files the developer already has", () => {
  it("4. ~/.claude.json keeps every key and server in order, ours is added last, and uninstall puts the file back byte for byte", () => {
    const s = sandbox();
    const file = join(s.home, ".claude.json");
    const original = `${JSON.stringify({ numStartups: 3, mcpServers: { db: { type: "stdio", command: "db-mcp", args: [], env: { A: "1" } } }, projects: { "/x": { allowedTools: [] } } }, null, 2)}\n`;
    write(file, original);
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    const merged = JSON.parse(read(file)) as Record<string, unknown> & { mcpServers: Record<string, unknown> };
    expect(Object.keys(merged)).toEqual(["numStartups", "mcpServers", "projects"]);
    expect(Object.keys(merged.mcpServers)).toEqual(["db", "openqodex"]);
    expect(merged.mcpServers.db).toEqual({ type: "stdio", command: "db-mcp", args: [], env: { A: "1" } });
    expect(merged.projects).toEqual({ "/x": { allowedTools: [] } });
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(read(file)).toBe(original);
  });

  it("7. a file with no mcpServers gets one, and uninstall takes it out again", () => {
    const s = sandbox();
    const file = join(s.home, ".cursor", "mcp.json");
    const original = `${JSON.stringify({ other: true }, null, 2)}\n`;
    write(file, original);
    expect(cli(s, ["init", "--yes", "--agent", "cursor", ...QUIET]).status).toBe(0);
    expect(read(file)).toBe(jsonFile({ openqodex: stdio(launcher(s), ["mcp"]) }, { other: true }));
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(read(file)).toBe(original);
  });

  it("4. a Codex config.toml with no final newline gets one before the block, and uninstall restores the file byte for byte", () => {
    const s = sandbox();
    const file = join(s.home, ".codex", "config.toml");
    const original = 'model = "o3"\n\n[mcp_servers.db]\ncommand = "db-mcp"';
    write(file, original);
    const r = cli(s, ["init", "--yes", "--agent", "codex", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(read(file)).toBe(`${original}\n${tomlBlock(launcher(s), ["mcp"])}`);
    expect(parseToml(file)).toEqual({ model: "o3", mcp_servers: { db: { command: "db-mcp" }, openqodex: { command: launcher(s), args: ["mcp"] } } });
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(read(file)).toBe(original);
  });

  it("7. uninstall leaves a block the developer edited, and the developer's lines after the block", () => {
    const s = sandbox();
    const file = join(s.home, ".codex", "config.toml");
    write(file, 'model = "o3"\n');
    expect(cli(s, ["init", "--yes", "--agent", "codex", ...QUIET]).status).toBe(0);
    const edited = read(file).replace('args = ["mcp"]', 'args = ["mcp", "--cwd", "/x"]');
    write(file, `${edited}\n[profiles.fast]\nmodel = "o4"\n`);
    const again = cli(s, ["init", "--yes", "--agent", "codex", ...QUIET]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/keep .*config\.toml.*edited/);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(read(file)).toBe(`${edited}\n[profiles.fast]\nmodel = "o4"\n`);
  });
});

describe("5. a file init cannot read as an MCP file", () => {
  it("is refused and left byte-identical, the other agent is installed, and init exits 2", () => {
    for (const text of ["{ not json,\n", '{"mcpServers": []}\n', "[]\n"]) {
      const s = sandbox();
      const file = join(s.home, ".claude.json");
      write(file, text);
      const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "cursor", ...QUIET]);
      expect(r.status, text).toBe(2);
      expect(r.stdout).toMatch(/refuse .*\.claude\.json/);
      expect(read(file)).toBe(text);
      expect(existsSync(join(s.home, ".cursor", "mcp.json"))).toBe(true);
    }
  }, 120_000);
});

describe("6. a server named openqodex that init did not write", () => {
  it("in a JSON file, is kept on install and on uninstall, and init says so", () => {
    const s = sandbox();
    const file = join(s.home, ".cursor", "mcp.json");
    const original = jsonFile({ openqodex: { command: "my-own-openqodex" } });
    write(file, original);
    const r = cli(s, ["init", "--yes", "--agent", "cursor", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/keep .*mcp\.json.*did not write/);
    expect(read(file)).toBe(original);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(read(file)).toBe(original);
  });

  it("in Codex's config.toml, in any spelling of the key, no block is appended and the file stays as it was", () => {
    const spellings = [
      '[mcp_servers.openqodex]\ncommand = "mine"\n',
      '[ "mcp_servers" . \'openqodex\' ]\ncommand = "mine"\n',
      '[mcp_servers.openqodex.env]\nA = "1"\n',
      '[mcp_servers]\nopenqodex = { command = "mine" }\n',
      '[mcp_servers]\nopenqodex.command = "mine"\n',
      'mcp_servers.openqodex.command = "mine"\n',
      'mcp_servers = { openqodex = { command = "mine" } }\n',
      // An inline table cannot be extended by a [mcp_servers.openqodex] table.
      'mcp_servers = { db = { command = "db-mcp" } }\n',
    ];
    for (const text of spellings) {
      const s = sandbox();
      const file = join(s.home, ".codex", "config.toml");
      write(file, text);
      const r = cli(s, ["init", "--yes", "--agent", "codex", ...QUIET]);
      expect(r.status, `${text}\n${r.stderr}`).toBe(0);
      expect(r.stdout, text).toMatch(/keep .*config\.toml/);
      expect(read(file), text).toBe(text);
    }
  }, 180_000);

  it("14. in Codex's config.toml, a quoted, escaped, spaced or array-of-tables key: no block is appended and the file stays as it was", () => {
    const spellings = [
      '[mcp_servers."openqodex"]\ncommand = "mine"\n',
      "[mcp_servers.'openqodex']\ncommand = \"mine\"\n",
      '[mcp_servers."open\\u0071odex"]\ncommand = "mine"\n',
      '[mcp_servers."open\\U00000071odex"]\ncommand = "mine"\n',
      'mcp_servers."openqodex".command = "mine"\n',
      '"mcp_servers" . openqodex . command = "mine"\n',
      '[[mcp_servers.openqodex]]\ncommand = "mine"\n',
    ];
    for (const text of spellings) {
      const s = sandbox();
      const file = join(s.home, ".codex", "config.toml");
      write(file, text);
      const r = cli(s, ["init", "--yes", "--agent", "codex", ...QUIET]);
      expect(r.status, `${text}\n${r.stderr}`).toBe(0);
      expect(r.stdout, text).toMatch(/keep .*config\.toml.*already defines a server named openqodex/);
      expect(read(file), text).toBe(text);
    }
  }, 180_000);

  it("14. text that only looks like the server inside a string is not a definition: the block is appended and the file still parses", () => {
    const texts = [
      'motto = "see # [mcp_servers.openqodex]"\n',
      'notes = """\n[mcp_servers.openqodex]\ncommand = "x"\n"""\n',
    ];
    for (const text of texts) {
      const s = sandbox();
      const file = join(s.home, ".codex", "config.toml");
      write(file, text);
      const r = cli(s, ["init", "--yes", "--agent", "codex", ...QUIET]);
      expect(r.status, `${text}\n${r.stderr}`).toBe(0);
      expect(read(file), text).toBe(`${text}${tomlBlock(launcher(s), ["mcp"])}`);
      expect((parseToml(file).mcp_servers as Record<string, unknown>).openqodex, text).toEqual({ command: launcher(s), args: ["mcp"] });
    }
  });

  it("14. a config.toml that is not TOML is left untouched, and the plan says it could not be read as TOML", () => {
    const s = sandbox();
    const file = join(s.home, ".codex", "config.toml");
    const text = 'model = "o3\n[mcp_servers.db]\n';
    write(file, text);
    const r = cli(s, ["init", "--yes", "--agent", "codex", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/keep .*config\.toml.*could not be read as TOML/);
    expect(read(file)).toBe(text);
  });
});

describe("8. --no-mcp and --mcp", () => {
  it("the plan names the opt-out; --no-mcp writes no MCP file, a later --yes keeps it out, and --mcp adds it", () => {
    const s = sandbox();
    const dry = cli(s, ["init", "--dry-run", "--agent", "claude-code"]);
    expect(dry.stdout).toContain("To leave out the code graph's MCP server for your agents: --no-mcp.");
    expect(dry.stdout).toContain(join(s.home, ".claude.json"));
    expect(cli(s, ["init", "--yes", "--no-mcp", "--agent", "claude-code", "--agent", "codex", ...QUIET]).status).toBe(0);
    expect(existsSync(join(s.home, ".claude.json"))).toBe(false);
    expect(existsSync(join(s.home, ".codex", "config.toml"))).toBe(false);
    const later = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "codex", ...QUIET]);
    expect(later.status, later.stderr).toBe(0);
    expect(later.stdout).toContain("as chosen before");
    expect(existsSync(join(s.home, ".claude.json"))).toBe(false);
    expect(cli(s, ["init", "--yes", "--mcp", "--agent", "claude-code", "--agent", "codex", ...QUIET]).status).toBe(0);
    expect(read(join(s.home, ".claude.json"))).toBe(jsonFile({ openqodex: stdio(launcher(s), ["mcp"]) }));
    expect(read(join(s.home, ".codex", "config.toml"))).toBe(tomlBlock(launcher(s), ["mcp"]));
  }, 120_000);

  it("--no-mcp after an install removes what init recorded and keeps an entry the developer edited", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "cursor", ...QUIET]).status).toBe(0);
    const cursor = join(s.home, ".cursor", "mcp.json");
    const edited = jsonFile({ openqodex: { ...stdio(launcher(s), ["mcp"]), env: { A: "1" } } });
    write(cursor, edited);
    const r = cli(s, ["init", "--yes", "--no-mcp", "--agent", "claude-code", "--agent", "cursor", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.home, ".claude.json"))).toBe(false);
    expect(read(cursor)).toBe(edited);
  });
});

describe("9. --project", () => {
  it("writes .mcp.json, .cursor/mcp.json and .codex/config.toml with the pinned npx form, says what each agent asks first, and gives Cline a note", () => {
    const s = sandbox();
    const r = cli(s, ["init", "--yes", "--project", "--agent", "all"]);
    expect(r.status, r.stderr).toBe(0);
    const npx = jsonFile({ openqodex: stdio("npx", PINNED) });
    expect(read(join(s.repo, ".mcp.json"))).toBe(npx);
    expect(read(join(s.repo, ".cursor", "mcp.json"))).toBe(npx);
    expect(read(join(s.repo, ".codex", "config.toml"))).toBe(tomlBlock("npx", PINNED));
    expect(statSync(join(s.repo, ".mcp.json")).mode & 0o777).toBe(0o644);
    expect(r.stdout).toMatch(/\.mcp\.json .*approve/);
    expect(r.stdout).toMatch(/config\.toml .*trusted/);
    expect(r.stdout).toMatch(/Cline.*Configure MCP Servers/);
    expect(existsSync(join(s.home, ".claude.json"))).toBe(false);
    expect(existsSync(join(s.repo, ".cline", "data"))).toBe(false);
  });
});

describe("11. the Claude Code permission rules for the graph", () => {
  it("permissions.allow holds the graph command line and no rule for an MCP server", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code", ...QUIET]).status).toBe(0);
    const allow = (JSON.parse(read(join(s.home, ".claude", "settings.json"))) as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow.filter((r) => / graph\b|^mcp__/.test(r))).toEqual([`Bash(${launcher(s).includes(" ") ? `'${launcher(s)}'` : launcher(s)} graph *)`]);
  });
});

describe("13. no rule for the tools of a server named openqodex", () => {
  const settings = (s: Sandbox): string => join(s.home, ".claude", "settings.json");
  const rules = (s: Sandbox): string[] => (JSON.parse(read(settings(s))) as { permissions: { allow: string[] } }).permissions.allow;
  const graphRule = (s: Sandbox): string => `Bash(${launcher(s).includes(" ") ? `'${launcher(s)}'` : launcher(s)} graph *)`;

  it("13. the user-scope server is OpenQodex's and a project's .mcp.json names another server openqodex: no mcp__openqodex rule", () => {
    const s = sandbox({ ".mcp.json": jsonFile({ openqodex: { command: "someone-else" } }) });
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect((JSON.parse(read(join(s.home, ".claude.json"))) as { mcpServers: Record<string, unknown> }).mcpServers.openqodex).toEqual(stdio(launcher(s), ["mcp"]));
    expect(rules(s).filter((x) => x.startsWith("mcp__"))).toEqual([]);
    expect(rules(s)).toContain(graphRule(s));
  });

  it("13. the mcp__openqodex rule an earlier build recorded is removed by the next init", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code", ...QUIET]).status).toBe(0);
    // As an earlier build of this version left it: the rule granted and recorded.
    const data = JSON.parse(read(settings(s))) as { permissions: { allow: string[] } };
    data.permissions.allow.push("mcp__openqodex");
    write(settings(s), `${JSON.stringify(data, null, 2)}\n`);
    const recordPath = join(s.oqHome, "install.json");
    const record = JSON.parse(read(recordPath)) as { allowRules: { path: string; rule: string }[] };
    record.allowRules.push({ path: settings(s), rule: "mcp__openqodex" });
    write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", ...QUIET]);
    expect(r.status, r.stderr).toBe(0);
    expect(rules(s)).not.toContain("mcp__openqodex");
    expect(rules(s)).toContain(graphRule(s));
    const after = JSON.parse(read(recordPath)) as { allowRules: { rule: string }[] };
    expect(after.allowRules.map((a) => a.rule)).not.toContain("mcp__openqodex");
  }, 120_000);
});

describe("12. Claude Code writes ~/.claude.json while init runs", () => {
  const start = `${JSON.stringify({ numStartups: 1, mcpServers: { db: { command: "db-mcp" } } }, null, 2)}\n`;

  it("a change elsewhere in the file between the plan and the write is kept, and the server is added", () => {
    const s = sandbox();
    const file = join(s.home, ".claude.json");
    write(file, start);
    const changed = `${JSON.stringify({ numStartups: 2, mcpServers: { db: { command: "db-mcp" } }, tipsShown: true }, null, 2)}\n`;
    const r = inTerminal(s, ["init", "--agent", "claude-code", ...QUIET], [["Write these files?", "\r", `printf '%s' '${changed}' > '${file}'`]]);
    expect(r.status, r.stdout).toBe(0);
    expect(JSON.parse(read(file))).toEqual({ numStartups: 2, mcpServers: { db: { command: "db-mcp" }, openqodex: stdio(launcher(s), ["mcp"]) }, tipsShown: true });
  });

  it("a change to the openqodex entry itself between the plan and the write is refused, and the file is left as it was then", () => {
    const s = sandbox();
    const file = join(s.home, ".claude.json");
    write(file, start);
    const changed = `${JSON.stringify({ numStartups: 2, mcpServers: { db: { command: "db-mcp" }, openqodex: { command: "mine" } } }, null, 2)}\n`;
    const r = inTerminal(s, ["init", "--agent", "claude-code", ...QUIET], [["Write these files?", "\r", `printf '%s' '${changed}' > '${file}'`]]);
    expect(r.status, r.stdout).toBe(2);
    expect(r.stdout).toContain("changed while init was running");
    expect(read(file)).toBe(changed);
  });
});
