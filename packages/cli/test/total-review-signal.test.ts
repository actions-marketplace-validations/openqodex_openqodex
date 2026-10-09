// `openqodex review` stopped by a signal while its reviewer works: the built
// CLI as a real process, the real Claude Code driver, and a stand-in `claude`
// on PATH as the model provider (it answers detection, then starts a child of
// its own and waits, the way an agent with a running tool would).
//
// Ways it could fail, written before the code:
//  1. Ctrl-C or a kill ends the CLI but leaves the reviewer, which runs in a
//     process group of its own, and its children running.
//  2. The snapshot of the change stays on disk after the signal.
//  3. The exit code is not the conventional one (130 for SIGINT, 143 for SIGTERM).
//  4. A signal during Codex's sandbox probe, before any reviewer session
//     exists, leaves the probe's process group running or its canary file in
//     the openqodex home.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// The stand-in `claude`: `--version` and `auth status` as Claude Code answers
// them; started as the reviewer, it writes its pid and its child's, then waits.
function standIn(pids: string): string {
  const dir = tempDir("oq-signal-bin-");
  writeFileSync(
    join(dir, "claude"),
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
      "if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
      "process.stdin.once('data', () => {",
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `  writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid);`,
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 100));
  }
}

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
  describe(`${signal} during the review`, () => {
    it(`1, 2, 3. kills the reviewer's process group, removes the snapshot and exits ${code}`, async () => {
      const repo = tempDir("oq-signal-repo-");
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "README.md"), "hello\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "Base");
      mkdirSync(join(repo, "db"));
      writeFileSync(join(repo, "db/x.sql"), "SELECT 1;\n");
      const home = tempDir("oq-signal-home-");
      const pids = join(tempDir("oq-signal-pids-"), "pids");
      const env: NodeJS.ProcessEnv = { ...process.env, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0", PATH: [standIn(pids), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) };
      delete env.OPENQODEX_REVIEW_DEPTH;
      const cli = spawn(process.execPath, [BIN, "review", "--only", "sqllint", "--no-install", "--no-graph"], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      cli.stderr.on("data", (b: Buffer) => (stderr += String(b)));
      const exited = new Promise<number | null>((done) => cli.once("exit", (c) => done(c)));
      await waitFor(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" "), 30_000).catch(() => {
        throw new Error(`the reviewer never started: ${stderr}`);
      });
      const [reviewer, child] = readFileSync(pids, "utf8").split(" ").map(Number) as [number, number];
      expect(readdirSync(join(home, "checkouts"))).toHaveLength(1);
      cli.kill(signal);
      expect(await exited).toBe(code);
      await new Promise((done) => setTimeout(done, 300));
      expect([reviewer, child].filter(alive)).toEqual([]);
      expect(readdirSync(join(home, "checkouts"))).toEqual([]);
    }, 60_000);
  });
}

// The stand-in `codex`: `--version` and `login status` as Codex answers them;
// started for the sandbox probe, it writes its pid and its child's, then waits.
function codexStandIn(pids: string): string {
  const dir = tempDir("oq-signal-codex-");
  writeFileSync(
    join(dir, "codex"),
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }",
      "if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid);`,
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "codex"), 0o755);
  return dir;
}

describe("SIGTERM during Codex's sandbox probe", () => {
  it("4. kills the probe's process group and removes its canary and snapshot", async () => {
    const repo = tempDir("oq-signal-repo-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "Base");
    writeFileSync(join(repo, "x.sql"), "SELECT 1;\n");
    const home = tempDir("oq-signal-home-");
    const pids = join(tempDir("oq-signal-pids-"), "pids");
    const env: NodeJS.ProcessEnv = { ...process.env, OPENQODEX_HOME: home, OPENQODEX_AUTO_UPDATE: "0", PATH: [codexStandIn(pids), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) };
    for (const k of ["OPENQODEX_REVIEW_DEPTH", "CODEX_SANDBOX", "CODEX_THREAD_ID", "CLAUDECODE"]) delete env[k];
    const cli = spawn(process.execPath, [BIN, "review", "--reviewer", "codex", "--only", "sqllint", "--no-install", "--no-graph"], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    cli.stderr.on("data", (b: Buffer) => (stderr += String(b)));
    const exited = new Promise<number | null>((done) => cli.once("exit", (c) => done(c)));
    await waitFor(() => existsSync(pids) && readFileSync(pids, "utf8").includes(" "), 30_000).catch(() => {
      throw new Error(`the probe never started: ${stderr}`);
    });
    const [probe, child] = readFileSync(pids, "utf8").split(" ").map(Number) as [number, number];
    expect(readdirSync(home).filter((n) => n.startsWith(".openqodex-probe"))).toHaveLength(1);
    cli.kill("SIGTERM");
    expect(await exited).toBe(143);
    await new Promise((done) => setTimeout(done, 300));
    expect([probe, child].filter(alive)).toEqual([]);
    expect(readdirSync(home).filter((n) => n.startsWith(".openqodex-probe"))).toEqual([]);
    expect(readdirSync(join(home, "checkouts"))).toEqual([]);
  }, 60_000);
});
