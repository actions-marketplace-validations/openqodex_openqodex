// The self-update's safety cases from the code review, and two additions:
// uninstall removes the update files, and init allows the review commands in
// Claude Code. Real built CLI, real launcher, real child processes; the
// child processes import this repo's own modules through bundle.ts.
//
// Ways it could fail, written before the code:
//  1. A recorded runtime folder of the candidate's version, with other bytes
//     than the verified release, is activated instead of the verified copy.
//  2. Two processes both take over one stale install.lock or update.lock and
//     both enter.
//  3. A worker killed before the pointer write leaves the new version active;
//     one killed after it leaves `previous` wrong, so rollback goes astray.
//  4. A refresh that fails part way leaves earlier agent files on the new
//     version while the old runtime stays active.
//  5. Two processes writing update.json at once lose one write.
//  6. Rollback reports success while `update: off` could not be written.
//  7. `scan --offline --bad-flag` starts a worker; so does a command that failed to parse.
//  8. A finalize handed to another version selects another run, or hands off again.
//  9. A project-scope skill tells the agent to use the updating launcher.
// 10. A team file the repo's git ignore rules hide is written and named as one to commit.
// 11. A queued daily worker checks again right after another one did.
// 12. A tarball member that is a link, or that leaves the folder, is unpacked.
// A.  Uninstall leaves update.json, update.lock or a config.yaml it created.
// B.  A review command line the skill names still asks for permission in
//     Claude Code; a rule has a wildcard after `review` or `scan`, so flags
//     such as --output <any path> pass unasked; `scan`, `doctor`, `trust`,
//     `update`, `init` or `report` are allowed; `init --project` commits rules
//     for the whole team; or a rule the developer had is removed.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { activate, reconcile } from "../src/update/activate.js";
import { readState } from "../src/update/state.js";
import { unpackRelease } from "../src/update/worker.js";
import { bundleChildEntry } from "./bundle.js";
import { BIN, cli, env, git, sandbox, snapshot, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const NEWER = "0.99.0";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function laptop(s: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e = env(s);
  for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_LAUNCHER", "OPENQODEX_FINALIZE_HANDOFF"]) delete e[key];
  return { ...e, ...extra };
}
function launch(s: Sandbox, args: string[], extra: Record<string, string> = {}, input = "") {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), ...args], { encoding: "utf8", env: laptop(s, extra), cwd: s.repo, input, timeout: 120_000 });
}
function installed(agents = ["claude-code"], files: Record<string, string> = {}): Sandbox {
  const s = sandbox(files);
  const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", ...agents.flatMap((a) => ["--agent", a])]);
  expect(r.status, r.stderr).toBe(0);
  return s;
}
function copyRuntime(from: string, to: string, v: string, edit?: (dir: string) => void): string {
  cpSync(from, to, { recursive: true });
  const bin = join(to, "dist/bin.js");
  writeFileSync(bin, readFileSync(bin, "utf8").replaceAll(`"${version}"`, `"${v}"`));
  edit?.(to);
  return to;
}
const rt = (s: Sandbox, v: string): string => join(s.oqHome, "runtime", v);
const current = (s: Sandbox): string => readFileSync(join(s.oqHome, "runtime/current"), "utf8").trim();
function deadPid(): number {
  const p = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(p.stdout);
}
// A verified copy as the worker leaves it before publishing: a whole package folder.
function unpackedCopy(s: Sandbox, v: string, edit?: (dir: string) => void): string {
  return copyRuntime(rt(s, version), join(mkdtempSync(join(tmpdir(), "oq-unpacked-")), "package"), v, edit);
}

let child = "";
beforeAll(async () => {
  expect(existsSync(BIN), "build the CLI first (pnpm build)").toBe(true);
  child = await bundleChildEntry();
}, 60_000);

// Runs `code` in a child node that has the bundled modules as `m`.
function nodeChild(code: string, extra: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(child)});\n${code}`], {
    env: { ...process.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function exited(p: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((r) => p.once("exit", (code) => r(code)));
}

describe("1. a recorded runtime of the candidate's version", () => {
  it("is replaced by the verified copy when its bytes differ", async () => {
    const s = installed();
    copyRuntime(rt(s, version), rt(s, NEWER), NEWER, (d) => writeFileSync(join(d, "LOCAL-BUILD"), "not the release\n"));
    const rec = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { runtimes: string[] };
    rec.runtimes.push(rt(s, NEWER));
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(rec, null, 2));
    const unpacked = unpackedCopy(s, NEWER);
    const result = await activate({ home: s.oqHome, version: NEWER, from: version, env: laptop(s), unpacked });
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(join(rt(s, NEWER), "LOCAL-BUILD"))).toBe(false);
    expect(current(s)).toBe(NEWER);
  }, 60_000);

  it("is refused, not replaced, when it is the active runtime and differs", async () => {
    const s = installed();
    const unpacked = unpackedCopy(s, version, (d) => writeFileSync(join(d, "OTHER"), "x\n"));
    const result = await activate({ home: s.oqHome, version, from: version, env: laptop(s), unpacked });
    expect(result.ok).toBe(false);
    expect(existsSync(join(rt(s, version), "OTHER"))).toBe(false);
  }, 60_000);
});

describe("2. stale lock takeover", () => {
  for (const which of ["install.lock", "update.lock"]) {
    it(`six processes over one stale ${which} enter one at a time`, async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-lock-")));
      writeFileSync(join(home, which), `${deadPid()} deadtoken\n`);
      const log = join(home, "log");
      const enter =
        which === "install.lock"
          ? `await m.withLock(process.env.H, async () => { appendFileSync(process.env.L, "in\\n"); await new Promise((r) => setTimeout(r, 150)); appendFileSync(process.env.L, "out\\n"); });`
          : `for (;;) { const lock = m.takeLock(join(process.env.H, "update.lock")); if (lock) { appendFileSync(process.env.L, "in\\n"); await new Promise((r) => setTimeout(r, 150)); appendFileSync(process.env.L, "out\\n"); lock.release(); break; } await new Promise((r) => setTimeout(r, 20)); }`;
      const code = `import("node:fs").then(async ({ appendFileSync }) => { const { join } = await import("node:path"); ${enter} });`;
      const kids = Array.from({ length: 6 }, () => nodeChild(`await ${code}`, { H: home, L: log }));
      const codes = await Promise.all(kids.map(exited));
      expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? "in" : "out")));
    }, 60_000);
  }
});

describe("3. an activation stopped part way by a kill", () => {
  async function killAt(stage: string): Promise<Sandbox> {
    const s = installed();
    copyRuntime(rt(s, version), rt(s, NEWER), NEWER);
    const p = nodeChild(`await m.activate({ home: process.env.H, version: ${JSON.stringify(NEWER)}, from: ${JSON.stringify(version)}, env: process.env });`, {
      ...laptop(s),
      H: s.oqHome,
      OPENQODEX_E2E: "1",
      OPENQODEX_UPDATE_PAUSE: stage,
    });
    for (let i = 0; i < 600 && !existsSync(join(s.oqHome, "update-paused")); i++) await sleep(50);
    expect(existsSync(join(s.oqHome, "update-paused")), "the child reached the pause").toBe(true);
    p.kill("SIGKILL");
    await exited(p);
    return s;
  }

  it("before the pointer: the launcher runs the old version and the next worker clears the journal", async () => {
    const s = await killAt("before-pointer");
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
    expect(readState(s.oqHome).activation).toEqual({ from: version, to: NEWER });
    await reconcile(s.oqHome);
    expect(readState(s.oqHome).activation).toBeNull();
    expect(current(s)).toBe(version);
  }, 120_000);

  it("after the pointer: rollback finishes the bookkeeping first and goes back to the right version", async () => {
    const s = await killAt("after-pointer");
    expect(launch(s, ["--version"]).stdout.trim()).toBe(NEWER);
    const r = launch(s, ["update", "--rollback"]);
    expect(r.status, r.stderr).toBe(0);
    expect(current(s)).toBe(version);
    expect(readState(s.oqHome).activation).toBeNull();
  }, 120_000);
});

describe("4. a refresh that fails part way", () => {
  it("puts back the files it already wrote and leaves the old version active", async () => {
    const s = installed(["claude-code", "codex"]);
    const skill = join(s.home, ".claude/skills/openqodex/SKILL.md");
    const before = readFileSync(skill, "utf8");
    copyRuntime(rt(s, version), rt(s, NEWER), NEWER, (d) => {
      writeFileSync(join(d, "skills/openqodex/SKILL.md"), `${readFileSync(join(d, "skills/openqodex/SKILL.md"), "utf8")}\nNEWER SKILL LINE\n`);
    });
    // The Codex skill comes after the Claude Code one and cannot be written.
    const codexDir = join(s.home, ".agents/skills/openqodex");
    chmodSync(codexDir, 0o555);
    try {
      const result = await activate({ home: s.oqHome, version: NEWER, from: version, env: laptop(s) });
      expect(result.ok).toBe(false);
    } finally {
      chmodSync(codexDir, 0o755);
    }
    expect(readFileSync(skill, "utf8")).toBe(before);
    expect(current(s)).toBe(version);
  }, 60_000);
});

describe("5. update.json written by two processes at once", () => {
  it("keeps both processes' last writes", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-state-")));
    const writer = (field: string) =>
      nodeChild(`for (let i = 1; i <= 150; i++) m.updateState(process.env.H, { ${field}: String(i) });`, { H: home });
    const codes = await Promise.all([writer("installed"), writer("lastError")].map(exited));
    expect(codes).toEqual([0, 0]);
    expect(readState(home)).toMatchObject({ installed: "150", lastError: "150" });
  }, 60_000);
});

describe("6. rollback when the off switch cannot be written", () => {
  it("fails and changes nothing", async () => {
    const s = installed();
    copyRuntime(rt(s, version), rt(s, NEWER), NEWER);
    expect(await activate({ home: s.oqHome, version: NEWER, from: version, env: laptop(s) })).toMatchObject({ ok: true });
    const locked = join(s.root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "config.yaml"), "update: on\n");
    symlinkSync(join(locked, "config.yaml"), join(s.oqHome, "config.yaml"));
    chmodSync(locked, 0o555);
    try {
      const r = launch(s, ["update", "--rollback"]);
      expect(r.status).toBe(2);
      expect(r.stdout).not.toMatch(/Rolled back/);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(current(s)).toBe(NEWER);
  }, 60_000);
});

describe("7. a command that did not parse", () => {
  it("--offline with a bad flag, and a bad flag alone, start no worker", async () => {
    const a = installed();
    const b = installed();
    launch(a, ["scan", "--offline", "--bad-flag"]);
    launch(b, ["scan", "--bad-flag"]);
    await sleep(2500);
    expect(readState(a.oqHome).checkedAt).toBeNull();
    expect(readState(b.oqHome).checkedAt).toBeNull();
  }, 60_000);
});

describe("8. finalize handed to another version", () => {
  let s: Sandbox;
  const submit = (dir: string): void => {
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { candidates: { id: string }[] };
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { change_id: string };
    writeFileSync(
      join(dir, "agent-findings.json"),
      JSON.stringify({ version: 1, change_id: manifest.change_id, summary: "Looked", reviewer: "subagent", findings: [], dropped: scan.candidates.map((c) => ({ candidate: c.id, reason: "Not actionable here" })) }),
    );
  };
  const latestDir = (): string => join(s.repo, (JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string }).dir);
  let oldRun = "";
  let newRun = "";

  beforeAll(async () => {
    s = installed();
    writeFileSync(join(s.oqHome, "update.json"), JSON.stringify({ checkedAt: new Date().toISOString() }));
    writeFileSync(join(s.repo, "app.py"), "print('hello')\n");
    git(s.repo, "add", "app.py");
    expect(launch(s, ["review", "--agent", "--no-install"]).status).toBe(0);
    oldRun = latestDir();
    submit(oldRun);
    copyRuntime(rt(s, version), rt(s, NEWER), NEWER);
    expect(await activate({ home: s.oqHome, version: NEWER, from: version, env: laptop(s) })).toMatchObject({ ok: true });
    // A newer brief by the new version moves latest.json on.
    await sleep(1100);
    expect(launch(s, ["review", "--agent", "--no-install"]).status).toBe(0);
    newRun = latestDir();
    expect(newRun).not.toBe(oldRun);
  }, 180_000);

  it("the old run named by its path is finalized by its own version, and the newer run is untouched", () => {
    const r = launch(s, ["review", "--finalize", join(oldRun, "agent-findings.json")]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(oldRun, "report.json"))).toBe(true);
    expect(existsSync(join(newRun, "report.json"))).toBe(false);
  });

  it("a runtime reached by a handoff does not hand off again", () => {
    const r = launch(s, ["review", "--finalize", join(oldRun, "agent-findings.json")], { OPENQODEX_FINALIZE_HANDOFF: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/handed/);
  });
});

describe("9 and 10. what init writes into a repository", () => {
  it("a project-scope skill keeps only the pinned npx commands (failure 9)", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "claude-code"]).status).toBe(0);
    const text = readFileSync(join(s.repo, ".claude/skills/openqodex/SKILL.md"), "utf8");
    expect(text).not.toContain("~/.openqodex/bin/openqodex");
    expect(text).toContain(`npx -y openqodex@${version} review --agent`);
  });

  it("a team file the repo ignores is not written and not named to commit (failure 10)", () => {
    const s = sandbox({ ".gitignore": "CLAUDE.md\n" });
    const r = cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.repo, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(s.repo, "AGENTS.md"), "utf8")).toContain("openqodex");
    expect(r.stdout).toMatch(/CLAUDE\.md.*ignore/);
    expect(r.stdout).toMatch(/Commit AGENTS\.md so/);
  });
});

describe("11. a queued daily worker", () => {
  it("does not check when another checked under an hour ago", () => {
    const s = installed();
    const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(join(s.oqHome, "update.json"), JSON.stringify({ checkedAt: at }));
    const r = launch(s, ["__update"]);
    expect(r.status).toBe(0);
    expect(readState(s.oqHome).checkedAt).toBe(at);
  });
});

describe("12. a hostile release archive", () => {
  const gnu = /GNU/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout);
  function tarball(build: (dir: string) => string[]): Buffer {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "oq-tar-")));
    mkdirSync(join(dir, "package/dist"), { recursive: true });
    writeFileSync(join(dir, "package/dist/bin.js"), "console.log('x')\n");
    const out = join(dir, "x.tgz");
    const r = spawnSync("tar", ["-czf", out, ...build(dir)], { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(out);
  }
  it("a member that is a link is refused", async () => {
    const tgz = tarball((dir) => {
      symlinkSync("/etc/passwd", join(dir, "package/evil"));
      return ["package"];
    });
    const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-hostile-")));
    await expect(unpackRelease(home, "9.9.9", tgz)).rejects.toThrow(/link/);
    expect(existsSync(join(home, "runtime/9.9.9"))).toBe(false);
  });
  it("a member that leaves the folder is refused", async () => {
    const tgz = tarball((dir) => {
      writeFileSync(join(dir, "escape"), "x\n");
      return gnu ? ["--transform", "s,^escape,package/../../escape,", "package", "escape"] : ["-s", ",^escape,package/../../escape,", "package", "escape"];
    });
    const home = realpathSync(mkdtempSync(join(tmpdir(), "oq-hostile-")));
    await expect(unpackRelease(home, "9.9.9", tgz)).rejects.toThrow(/escapes/);
    expect(existsSync(join(home, "runtime/escape"))).toBe(false);
  });
});

describe("A. uninstall and the update files", () => {
  it("leaves the home folder as it was before init, update state and its config.yaml included", () => {
    const s = sandbox();
    const before = Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"));
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(launch(s, ["update", "--off"]).status).toBe(0);
    writeFileSync(join(s.oqHome, "update.json"), JSON.stringify({ ...readState(s.oqHome), checkedAt: new Date().toISOString() }));
    expect(existsSync(join(s.oqHome, "config.yaml"))).toBe(true);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(Object.keys(snapshot(s)).filter((p) => p.startsWith("home dir"))).toEqual(before);
  });

  it("leaves a config.yaml the developer wrote", () => {
    const s = sandbox();
    mkdirSync(s.oqHome, { recursive: true });
    writeFileSync(join(s.oqHome, "config.yaml"), "update: off\n# mine\n");
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(cli(s, ["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toBe("update: off\n# mine\n");
  });
});

describe("B. Claude Code permission rules", () => {
  // A home whose path needs no shell quoting, so the skill writes the
  // launcher bare and one rule matches it.
  function plain(): { home: string; oqHome: string; repo: string; run: (args: string[]) => ReturnType<typeof spawnSync> } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oqperm")));
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(repo);
    git(repo, "init", "-q");
    const oqHome = join(home, ".openqodex");
    const e = { ...process.env, HOME: home, OPENQODEX_HOME: oqHome, OPENQODEX_AUTO_UPDATE: "0" };
    delete e.CODEX_HOME;
    return { home, oqHome, repo, run: (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env: e, encoding: "utf8", input: "" }) };
  }
  const allow = (settings: string): string[] => ((JSON.parse(readFileSync(settings, "utf8")) as { permissions?: { allow?: string[] } }).permissions?.allow ?? []);

  // Claude Code's matching as its permissions page states it: a rule without
  // `*` matches one exact command; a trailing " *" also matches the bare command.
  const covers = (rules: string[], command: string): boolean =>
    rules.some((r) => {
      const body = r.slice("Bash(".length, -1);
      return body.endsWith(" *") ? command === body.slice(0, -2) || command.startsWith(body.slice(0, -1)) : command === body;
    });
  const EXACT = ["review --agent", "review --finalize", "review --agent --all", "review --finalize --all"];
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("allows exactly the review command lines and guide, with no wildcard after review", () => {
    const p = plain();
    const r = p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]);
    expect(r.status, String(r.stderr)).toBe(0);
    const launcher = join(p.oqHome, "bin/openqodex");
    const rules = allow(join(p.home, ".claude/settings.json"));
    expect(rules).toEqual([...EXACT, ...EXACT.map((c) => `${c} --offline`), "guide", "guide *"].map((c) => `Bash(${launcher} ${c})`));
    expect(rules.filter((x) => /(review|scan)[^)]*\*/.test(x))).toEqual([]);
    for (const banned of ["scan", "doctor", "trust", "update", "init", "report", "hook"]) {
      expect(rules.filter((x) => x.startsWith(`Bash(${launcher} ${banned}`)), banned).toEqual([]);
    }
    expect(String(r.stdout)).toContain(`Bash(${launcher} review --agent)`);
  });

  it("every command line the installed skill gives the agent is allowed, and trust, report and doctor are not", () => {
    const p = plain();
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const launcher = join(p.oqHome, "bin/openqodex");
    const rules = allow(join(p.home, ".claude/settings.json"));
    const skill = readFileSync(join(p.home, ".claude/skills/openqodex/SKILL.md"), "utf8");
    const lines = [...skill.matchAll(new RegExp(`${escape(launcher)} [^\`\n]*`, "g"))].map((m) => m[0].trim());
    const asked = lines.filter((l) => / (trust|report|doctor)\b/.test(l));
    const agentRuns = lines.filter((l) => !asked.includes(l) && !l.includes("<topic>"));
    expect(agentRuns).toContain(`${launcher} review --agent`);
    expect(agentRuns).toContain(`${launcher} review --finalize`);
    for (const l of agentRuns) expect(covers(rules, l), l).toBe(true);
    expect(covers(rules, `${launcher} guide config`)).toBe(true);
    for (const l of [`${launcher} trust`, `${launcher} report --send-last`, `${launcher} doctor --install`, `${launcher} review --agent --output /etc/x`, `${launcher} review --agent && rm -rf x`]) {
      expect(covers(rules, l), l).toBe(false);
    }
  });

  it("a second init adds no rule, and uninstall removes only the rules init added", () => {
    const p = plain();
    const launcher = join(p.oqHome, "bin/openqodex");
    mkdirSync(join(p.home, ".claude"));
    // The developer already had one of the same rules, and one of their own.
    writeFileSync(join(p.home, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls *)", `Bash(${launcher} guide)`] } }));
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const once = allow(join(p.home, ".claude/settings.json"));
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(allow(join(p.home, ".claude/settings.json"))).toEqual(once);
    expect(once.filter((r) => r === `Bash(${launcher} guide)`)).toHaveLength(1);
    expect(p.run(["init", "--uninstall", "--yes"]).status).toBe(0);
    expect(allow(join(p.home, ".claude/settings.json"))).toEqual(["Bash(ls *)", `Bash(${launcher} guide)`]);
  });

  // An install whose record holds a rule this version no longer grants (the
  // set changed between versions), beside a developer's own look-alike rule.
  function withStaleRule(): { p: ReturnType<typeof plain>; settings: string; stale: string; mine: string } {
    const p = plain();
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    const launcher = join(p.oqHome, "bin/openqodex");
    const settings = join(p.home, ".claude/settings.json");
    const stale = `Bash(${launcher} scan *)`;
    const mine = `Bash(${launcher} doctor *)`;
    const data = JSON.parse(readFileSync(settings, "utf8")) as { permissions: { allow: string[] } };
    data.permissions.allow.push(stale, mine);
    writeFileSync(settings, `${JSON.stringify(data, null, 2)}\n`);
    const rec = JSON.parse(readFileSync(join(p.oqHome, "install.json"), "utf8")) as { allowRules: { path: string; rule: string }[] };
    rec.allowRules.push({ path: settings, rule: stale });
    writeFileSync(join(p.oqHome, "install.json"), JSON.stringify(rec, null, 2));
    return { p, settings, stale, mine };
  }
  const recordedRules = (oqHome: string): string[] =>
    (JSON.parse(readFileSync(join(oqHome, "install.json"), "utf8")) as { allowRules: { rule: string }[] }).allowRules.map((r) => r.rule);

  it("a rule an earlier version granted is removed by the next init; the developer's own rule stays", () => {
    const { p, settings, stale, mine } = withStaleRule();
    expect(p.run(["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(allow(settings)).not.toContain(stale);
    expect(allow(settings)).toContain(mine);
    expect(recordedRules(p.oqHome)).not.toContain(stale);
  });

  it("a rule an earlier version granted is removed by __refresh; the developer's own rule stays", () => {
    const { p, settings, stale, mine } = withStaleRule();
    const version0 = readFileSync(join(p.oqHome, "runtime/current"), "utf8").trim();
    const r = spawnSync(process.execPath, [join(p.oqHome, "runtime", version0, "dist/bin.js"), "__refresh"], {
      env: { ...process.env, HOME: p.home, OPENQODEX_HOME: p.oqHome },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(allow(settings)).not.toContain(stale);
    expect(allow(settings)).toContain(mine);
    expect(recordedRules(p.oqHome)).not.toContain(stale);
  });

  it("a project-scope rule an earlier build recorded is removed on uninstall, and a settings file init did not create stays", () => {
    const s = sandbox({ ".claude/settings.json": `${JSON.stringify({ model: "x" }, null, 2)}\n` });
    expect(cli(s, ["init", "--yes", "--project", "--agent", "claude-code"]).status).toBe(0);
    const settings = join(s.repo, ".claude/settings.json");
    const old = `Bash(npx -y openqodex@${version} review *)`;
    const data = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    writeFileSync(settings, `${JSON.stringify({ ...data, permissions: { allow: [old] } }, null, 2)}\n`);
    const rec = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { allowRules: { path: string; rule: string }[] };
    rec.allowRules.push({ path: settings, rule: old });
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(rec, null, 2));
    expect(cli(s, ["init", "--uninstall", "--yes", "--project"]).status).toBe(0);
    expect(existsSync(settings)).toBe(true);
    expect(allow(settings)).toEqual([]);
    expect((JSON.parse(readFileSync(settings, "utf8")) as { model: string }).model).toBe("x");
  });

  it("--project writes no permission rule into the repository", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--project", "--agent", "claude-code"]).status).toBe(0);
    expect(allow(join(s.repo, ".claude/settings.json"))).toEqual([]);
  });
});
