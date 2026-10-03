// The self-update, through the real built CLI and the real launcher in temp
// homes, with no registry: the trigger, the switches, the notice, activation
// of a second real runtime, retention, rollback and finalize across versions.
// The download and verification of real releases is in
// tests/e2e/self-update.test.ts.
//
// Ways it could fail, written before the code:
//  1. A check starts within 24 hours of the last one.
//  2. --offline, OPENQODEX_AUTO_UPDATE=0, CI, `update: off` in the user
//     config, or a user config that does not parse still starts a worker.
//  3. A run not started through the launcher (npx, project scope) starts a worker.
//  4. The update changes the command's exit code.
//  5. The update writes anything on stdout, so --format json breaks.
//  6. The "updated" notice prints twice.
//  7. A worker killed after unpacking and before the pointer leaves a state
//     the launcher runs as the new version.
//  8. Two workers that started from the same version both activate.
//  9. Refresh overwrites an agent file the developer edited.
// 10. Refresh creates an integration that was not recorded.
// 11. Old runtimes are deleted while they are the baked-in, current or previous one.
// 12. Rollback leaves the launcher pointing at a missing runtime.
// 13. --rollback does not turn updating off.
// 14. Finalize after an activation runs the new version on an old brief.
// 15. Finalize executes a path taken from the manifest.
// 16. The brief's finalize command names a runner other than the one that wrote it.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { activate } from "../src/update/activate.js";
import { readState } from "../src/update/state.js";
import { BIN, cli, env, git, sandbox, type Sandbox } from "./init-helpers.js";

const version = (JSON.parse(readFileSync(join(BIN, "..", "..", "package.json"), "utf8")) as { version: string }).version;
const NEWER = "0.99.0";
const NOTICE = /openqodex updated to/;
const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The environment of a developer's laptop: no CI, no switch set.
function laptop(s: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e = env(s);
  for (const key of ["CI", "OPENQODEX_OFFLINE", "OPENQODEX_AUTO_UPDATE", "OPENQODEX_E2E", "OPENQODEX_LAUNCHER"]) delete e[key];
  return { ...e, ...extra };
}

function launch(s: Sandbox, args: string[], extra: Record<string, string> = {}, input = "") {
  return spawnSync("sh", [join(s.oqHome, "bin/openqodex"), ...args], { encoding: "utf8", env: laptop(s, extra), cwd: s.repo, input, timeout: 120_000 });
}

function direct(s: Sandbox, args: string[], extra: Record<string, string> = {}, input = "") {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: laptop(s, extra), cwd: s.repo, input, timeout: 120_000 });
}

function installed(agents = ["claude-code"]): Sandbox {
  const s = sandbox();
  const r = cli(s, ["init", "--yes", "--hook", "none", "--no-repo", ...agents.flatMap((a) => ["--agent", a])]);
  expect(r.status, r.stderr).toBe(0);
  return s;
}

function writeState(s: Sandbox, state: Record<string, unknown>): void {
  writeFileSync(join(s.oqHome, "update.json"), `${JSON.stringify(state)}\n`);
}

// A second real runtime: the installed copy with its version string changed,
// recorded in install.json the way the updater records one.
function copyRuntime(s: Sandbox, to: string, edit?: (dir: string) => void): string {
  const dir = join(s.oqHome, "runtime", to);
  cpSync(join(s.oqHome, "runtime", version), dir, { recursive: true });
  const bin = join(dir, "dist/bin.js");
  writeFileSync(bin, readFileSync(bin, "utf8").replaceAll(`"${version}"`, `"${to}"`));
  edit?.(dir);
  return dir;
}

function record(s: Sandbox): { runtimes: string[]; files: { path: string }[] } {
  return JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { runtimes: string[]; files: { path: string }[] };
}

function current(s: Sandbox): string {
  return readFileSync(join(s.oqHome, "runtime/current"), "utf8").trim();
}

function setCurrent(s: Sandbox, v: string): void {
  writeFileSync(join(s.oqHome, "runtime/current"), `${v}\n`);
}

function age(path: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(path, t, t);
}

describe("when a check starts", () => {
  // Each sandbox runs one command through the launcher (or not) with an
  // update due, then the test waits once. A worker writes checkedAt as its
  // first act, so a missing checkedAt after the wait means none started.
  const cases: Record<string, { s?: Sandbox; run: (s: Sandbox) => void; setup?: (s: Sandbox) => void }> = {
    control: { run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    recent: { setup: (s) => writeState(s, { checkedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    offlineFlag: { run: (s) => launch(s, ["scan", "--offline", "--no-install"]) },
    offlineEnv: { run: (s) => launch(s, ["hook", "check"], { OPENQODEX_OFFLINE: "1" }, "{}") },
    envSwitch: { run: (s) => launch(s, ["hook", "check"], { OPENQODEX_AUTO_UPDATE: "0" }, "{}") },
    ci: { run: (s) => launch(s, ["hook", "check"], { CI: "true" }, "{}") },
    configOff: { setup: (s) => writeFileSync(join(s.oqHome, "config.yaml"), "update: off\n"), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    configBroken: { setup: (s) => writeFileSync(join(s.oqHome, "config.yaml"), "update: [on\n"), run: (s) => launch(s, ["hook", "check"], {}, "{}") },
    npx: { run: (s) => direct(s, ["hook", "check"], {}, "{}") },
  };
  const checkedAt = (s: Sandbox): unknown => readState(s.oqHome).checkedAt;
  let before: Record<string, unknown> = {};

  beforeAll(async () => {
    for (const c of Object.values(cases)) {
      c.s = installed();
      c.setup?.(c.s);
    }
    before = Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, checkedAt(c.s!)]));
    for (const c of Object.values(cases)) c.run(c.s!);
    // A worker that started has written checkedAt by now.
    for (let i = 0; i < 50 && checkedAt(cases.control.s!) === null; i++) await sleep(100);
    await sleep(1500);
  }, 120_000);

  it("a launcher run with a check due starts a worker (the control for the cases below)", () => {
    expect(checkedAt(cases.control.s!)).not.toBeNull();
  });
  it("a check does not start within 24 hours of the last (failure 1)", () => {
    expect(checkedAt(cases.recent.s!)).toBe(before.recent);
  });
  it("--offline starts no worker (failure 2)", () => expect(checkedAt(cases.offlineFlag.s!)).toBeNull());
  it("OPENQODEX_OFFLINE=1 starts no worker (failure 2)", () => expect(checkedAt(cases.offlineEnv.s!)).toBeNull());
  it("OPENQODEX_AUTO_UPDATE=0 starts no worker (failure 2)", () => expect(checkedAt(cases.envSwitch.s!)).toBeNull());
  it("CI starts no worker (failure 2)", () => expect(checkedAt(cases.ci.s!)).toBeNull());
  it("update: off in the user config starts no worker (failure 2)", () => expect(checkedAt(cases.configOff.s!)).toBeNull());
  it("a user config that does not parse starts no worker (failure 2)", () => expect(checkedAt(cases.configBroken.s!)).toBeNull());
  it("a run not started through the launcher starts no worker (failure 3)", () => expect(checkedAt(cases.npx.s!)).toBeNull());
});

describe("what the command prints and returns", () => {
  let s: Sandbox;
  beforeAll(() => {
    s = installed();
    writeFileSync(join(s.repo, "app.py"), "print('hello')\n");
  });

  it("the exit code is the same with an update due and with updates off (failure 4)", () => {
    const due = launch(s, ["scan", "--format", "json", "--no-install"]);
    const off = launch(s, ["scan", "--format", "json", "--no-install"], { OPENQODEX_AUTO_UPDATE: "0" });
    expect(due.status).toBe(off.status);
  });

  it("the notice goes to stderr, once, and stdout stays one JSON document (failures 5 and 6)", () => {
    writeState(s, { checkedAt: new Date().toISOString(), installed: version, previous: "0.0.1", notified: false });
    const first = launch(s, ["scan", "--format", "json", "--no-install"]);
    const second = launch(s, ["scan", "--format", "json", "--no-install"]);
    expect(() => JSON.parse(first.stdout)).not.toThrow();
    expect(first.stdout).not.toMatch(NOTICE);
    expect(first.stderr).toContain(`openqodex updated to ${version} (was 0.0.1). Roll back: openqodex update --rollback`);
    expect(second.stderr).not.toMatch(NOTICE);
  });
});

describe("activation", () => {
  let s: Sandbox;
  const skill = (x: Sandbox) => join(x.home, ".claude/skills/openqodex/SKILL.md");
  const globalMd = (x: Sandbox) => join(x.home, ".claude/CLAUDE.md");
  let editedBefore = "";
  let first: Awaited<ReturnType<typeof activate>>;
  let second: Awaited<ReturnType<typeof activate>>;

  beforeAll(async () => {
    s = installed();
    // The newer runtime ships a changed skill and instruction section, so a refresh shows.
    copyRuntime(s, NEWER, (dir) => {
      writeFileSync(join(dir, "skills/openqodex/SKILL.md"), `${readFileSync(join(dir, "skills/openqodex/SKILL.md"), "utf8")}\nNEWER SKILL LINE\n`);
      const section = join(dir, "templates/instructions-section.md");
      writeFileSync(section, readFileSync(section, "utf8").replace("<!-- openqodex:end -->", "NEWER SECTION LINE\n<!-- openqodex:end -->"));
    });
    // The developer edits the global instruction section by hand.
    writeFileSync(globalMd(s), readFileSync(globalMd(s), "utf8").replace("<!-- openqodex:end -->", "my own note\n<!-- openqodex:end -->"));
    editedBefore = readFileSync(globalMd(s), "utf8");
    // The hook file is removed by the developer: refresh must not bring it back.
    rmSync(join(s.home, ".claude/settings.json"));
    const e = laptop(s);
    first = await activate({ home: s.oqHome, version: NEWER, from: version, env: e });
    second = await activate({ home: s.oqHome, version: NEWER, from: version, env: e });
  }, 120_000);

  it("points current at the new runtime, records it and refreshes an owned file from the new runtime's templates", () => {
    expect(first).toMatchObject({ ok: true });
    expect(current(s)).toBe(NEWER);
    expect(record(s).runtimes).toContain(join(s.oqHome, "runtime", NEWER));
    expect(readFileSync(skill(s), "utf8")).toContain("NEWER SKILL LINE");
    const launched = launch(s, ["--version"]);
    expect(launched.stdout.trim()).toBe(NEWER);
    expect(readState(s.oqHome)).toMatchObject({ installed: NEWER, previous: version, notified: false });
  });

  it("a second worker from the same starting version does not activate (failure 8)", () => {
    expect(second.ok).toBe(false);
    expect(!second.ok && second.reason).toMatch(/active version/);
  });

  it("refresh leaves a file the developer edited and names it (failure 9)", () => {
    expect(readFileSync(globalMd(s), "utf8")).toBe(editedBefore);
    expect(readState(s.oqHome).kept).toContain(globalMd(s));
  });

  it("refresh creates no integration that was not recorded (failure 10)", () => {
    expect(existsSync(join(s.home, ".claude/settings.json"))).toBe(false);
    for (const p of [".codex", ".cursor", ".cline", ".agents", "Documents"]) expect(existsSync(join(s.home, p)), p).toBe(false);
  });
});

describe("one worker at a time", () => {
  it("a second worker exits while a live one holds update.lock, before any network call (failure 8)", () => {
    const s = installed();
    // This test process is alive: its pid in the lock is a live holder.
    writeFileSync(join(s.oqHome, "update.lock"), `${process.pid} sometoken\n`);
    const r = launch(s, ["update", "--now"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Another update is running.");
    expect(readState(s.oqHome).checkedAt).toBeNull();
  });
});

describe("a half-finished update", () => {
  it("a runtime unpacked but not pointed at is not what the launcher runs (failure 7)", () => {
    const s = installed();
    copyRuntime(s, NEWER);
    mkdirSync(join(s.oqHome, "runtime", `${NEWER}.tmp-12345`, "package"), { recursive: true });
    expect(current(s)).toBe(version);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
  });
});

describe("runtimes kept after an activation", () => {
  let s: Sandbox;
  const rt = (v: string) => join(s.oqHome, "runtime", v);
  beforeAll(async () => {
    s = installed();
    // 0.0.8 is active and old: it becomes the previous one.
    for (const v of ["0.0.5", "0.0.6", "0.0.7", "0.0.8"]) copyRuntime(s, v);
    copyRuntime(s, NEWER);
    const rec = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { runtimes: string[] };
    // 0.0.7 is not in install.json: not ours to remove.
    rec.runtimes.push(rt("0.0.5"), rt("0.0.6"), rt("0.0.8"));
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(rec, null, 2));
    for (const v of [version, "0.0.5", "0.0.7", "0.0.8"]) age(rt(v), 8);
    setCurrent(s, "0.0.8");
    const result = await activate({ home: s.oqHome, version: NEWER, from: "0.0.8", env: laptop(s) });
    expect(result).toMatchObject({ ok: true });
  }, 120_000);

  it("keeps the baked-in runtime even when it is old (failure 11)", () => expect(existsSync(rt(version))).toBe(true));
  it("keeps the previous runtime even when it is old (failure 11)", () => expect(existsSync(rt("0.0.8"))).toBe(true));
  it("keeps the current runtime (failure 11)", () => expect(existsSync(rt(NEWER))).toBe(true));
  it("keeps a recorded runtime younger than 7 days", () => expect(existsSync(rt("0.0.6"))).toBe(true));
  it("removes a recorded runtime older than 7 days and drops it from install.json", () => {
    expect(existsSync(rt("0.0.5"))).toBe(false);
    expect(record(s).runtimes).not.toContain(rt("0.0.5"));
  });
  it("leaves a runtime folder install.json does not name", () => expect(existsSync(rt("0.0.7"))).toBe(true));
});

describe("rollback", () => {
  it("points back at the previous runtime and turns updating off (failures 12 and 13)", async () => {
    const s = installed();
    copyRuntime(s, NEWER);
    expect(await activate({ home: s.oqHome, version: NEWER, from: version, env: laptop(s) })).toMatchObject({ ok: true });
    const r = launch(s, ["update", "--rollback"]);
    expect(r.status, r.stderr).toBe(0);
    expect(current(s)).toBe(version);
    expect(existsSync(join(s.oqHome, "runtime", version, "dist/bin.js"))).toBe(true);
    expect(launch(s, ["--version"]).stdout.trim()).toBe(version);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: off$/m);
    expect(launch(s, ["update", "--status"]).stdout).toMatch(/off/);
  }, 120_000);

  it("refuses when the previous runtime is gone and leaves the pointer alone (failure 12)", () => {
    const s = installed();
    writeState(s, { checkedAt: new Date().toISOString(), installed: version, previous: "0.0.9" });
    const r = launch(s, ["update", "--rollback"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/0\.0\.9/);
    expect(current(s)).toBe(version);
  });

  it("update --off and --on write the user config; --on refuses a config that does not parse", () => {
    const s = installed();
    expect(launch(s, ["update", "--off"]).status).toBe(0);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: off$/m);
    expect(launch(s, ["update", "--on"]).status).toBe(0);
    expect(readFileSync(join(s.oqHome, "config.yaml"), "utf8")).toMatch(/^update: on$/m);
    writeFileSync(join(s.oqHome, "config.yaml"), "update: [on\n");
    expect(launch(s, ["update", "--on"]).status).toBe(2);
  });

  it("update refuses to run when not started through the launcher", () => {
    const s = installed();
    const r = direct(s, ["update"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/npx openqodex init/);
  });
});

describe("finalize across versions", () => {
  let s: Sandbox;
  let brief = "";
  const findings = (): string => {
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string };
    return join(s.repo, latest.dir, "agent-findings.json");
  };
  const manifestPath = (): string => join(findings(), "..", "manifest.json");
  const submit = (): void => {
    const dir = join(findings(), "..");
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { change_id?: string; candidates: { id: string }[] };
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as { change_id: string };
    writeFileSync(
      findings(),
      JSON.stringify({
        version: 1,
        change_id: manifest.change_id,
        summary: "Looked at the change",
        reviewer: "subagent",
        findings: [],
        dropped: scan.candidates.map((c) => ({ candidate: c.id, reason: "Not actionable here" })),
      }),
    );
  };

  beforeAll(async () => {
    s = installed();
    writeState(s, { checkedAt: new Date().toISOString() });
    writeFileSync(join(s.repo, "app.py"), "print('hello')\n");
    git(s.repo, "add", "app.py");
    const r = launch(s, ["review", "--agent", "--no-install"]);
    expect(r.status, r.stderr).toBe(0);
    brief = r.stdout;
    submit();
    copyRuntime(s, NEWER);
    expect(await activate({ home: s.oqHome, version: NEWER, from: version, env: laptop(s) })).toMatchObject({ ok: true });
  }, 180_000);

  it("the brief names the runtime that wrote it, not npx, when started through the launcher (failure 16)", () => {
    expect(brief).toContain(join(s.oqHome, "runtime", version, "dist", "bin.js"));
    expect(brief).not.toMatch(/npx -y openqodex@\S+ review --finalize/);
    expect(JSON.parse(readFileSync(manifestPath(), "utf8"))).toMatchObject({ version: 3, runtime_version: version });
  });

  it("the new runtime does not finalize a brief from another version when that version is not installed (failure 14)", () => {
    const rec = JSON.parse(readFileSync(join(s.oqHome, "install.json"), "utf8")) as { runtimes: string[] };
    const without = { ...rec, runtimes: rec.runtimes.filter((r) => r !== join(s.oqHome, "runtime", version)) };
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(without, null, 2));
    const r = launch(s, ["review", "--finalize"]);
    writeFileSync(join(s.oqHome, "install.json"), JSON.stringify(rec, null, 2));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`written by openqodex ${version.replaceAll(".", "\\.")}.*review --agent`));
    expect(existsSync(join(findings(), "..", "report.json"))).toBe(false);
  });

  it("finalize after an activation runs the version that wrote the brief (failure 14)", () => {
    const r = launch(s, ["review", "--finalize"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(findings(), "..", "report.json"))).toBe(true);
  });

  it("finalize never executes a path from the manifest (failure 15)", () => {
    const marker = join(s.root, "ran");
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as Record<string, unknown>;
    for (const bad of [`1.0.0; touch ${marker}`, "../../../../tmp/x", "0.0.1/../0.0.2"]) {
      writeFileSync(manifestPath(), JSON.stringify({ ...manifest, runtime_version: bad }));
      const r = launch(s, ["review", "--finalize"]);
      expect(r.status, bad).toBe(2);
      expect(existsSync(marker)).toBe(false);
    }
    writeFileSync(manifestPath(), JSON.stringify(manifest));
  });

  it("a run not started through the launcher writes today's npx finalize command (failure 16)", () => {
    const r = direct(s, ["review", "--agent", "--no-install"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`npx -y openqodex@${version} review --finalize`);
  });
});
