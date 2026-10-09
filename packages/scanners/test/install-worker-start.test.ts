// Which program the scanner install starts as its worker, from a throwaway
// script that imports the resolver the way a debug script would. These tests
// import the built package (dist) and start the built CLI: run `pnpm build`
// first. The first one downloads actionlint from GitHub into a fresh home.
//
// Ways it could fail, written before the code (issue #69):
// 1. The worker is the running script (process.argv[1]) started again, so a
//    script that imports the resolver starts itself, and each copy starts
//    another, without end.
// 2. One install starts more than one worker.
// 3. The worker is not the openqodex bin with its __install argument.
// 4. A process that is itself an install worker (the marker in its
//    environment) starts another worker.
// 5. A script that names no worker program gets one guessed for it instead
//    of a plain reason.
// 6. The install body runs in a program other than the one named, such as a
//    script that imports it and calls it, instead of stopping with one line.
// 7. A process that may not start an install also stops waiting on one that
//    another process already runs (init-review.test.ts, case 12, guards it).
//
// Every run here is capped: the throwaway script ends at once on its fourth
// start, the watcher kills every worker past the third and fails the test,
// and the script itself is killed after 80 seconds.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "index.js");
const bin = join(here, "..", "..", "cli", "dist", "bin.js");
const MARKER = "OPENQODEX_INSTALL_WORKER=1";
const MAX_STARTS = 3;

beforeAll(() => {
  if (!existsSync(dist) || !existsSync(bin)) throw new Error("run pnpm build before these tests");
});

// The throwaway script: notes each start of itself in a file, imports the
// resolver, names the worker program it is given (OQ_TEST_WORKER: a path,
// or "self" for its own file), and then either resolves actionlint or, with
// OQ_TEST_CALL=worker, calls the install body itself. A start past
// MAX_STARTS ends at once, so a script that starts itself again shows in
// the count instead of running on.
function throwaway(): { script: string; starts: string } {
  const dir = tempDir("oq-worker-script-");
  const script = join(dir, "debug.mjs");
  const starts = join(dir, "starts");
  writeFileSync(
    script,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(starts)}, process.pid + "\\n");`,
      `if (readFileSync(${JSON.stringify(starts)}, "utf8").trim().split("\\n").length > ${MAX_STARTS}) process.exit(0);`,
      `const tc = await import(${JSON.stringify(dist)});`,
      "const named = process.env.OQ_TEST_WORKER === 'self' ? process.argv[1] : process.env.OQ_TEST_WORKER;",
      "if (named) tc.setInstallWorkerEntry(named);",
      "if (process.env.OQ_TEST_CALL === 'worker') {",
      '  process.stdout.write(JSON.stringify({ code: await tc.runInstallWorker("actionlint") }));',
      "} else {",
      '  const r = await tc.createToolResolver({ allowInstall: true, installBudgetMs: null })("actionlint");',
      "  process.stdout.write(JSON.stringify(r));",
      "}",
      "",
    ].join("\n"),
  );
  return { script, starts };
}

// The live processes whose environment holds every one of `vars`, with
// their command lines. Linux keeps a process's environment in
// /proc/<pid>/environ; macOS prints it after the command with `ps -E`.
function processesWith(vars: string[]): Map<number, string> {
  const found = new Map<number, string>();
  if (process.platform === "linux") {
    for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        if (vars.every((v) => env.includes(v))) found.set(Number(pid), readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "));
      } catch {
        // The process ended or is not ours.
      }
    }
    return found;
  }
  const ps = execFileSync("ps", ["-A", "-E", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m && vars.every((v) => ` ${m[2]} `.includes(` ${v} `))) found.set(Number(m[1]), m[2]);
  }
  return found;
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

type Run = { home: string; result: Record<string, unknown>; stderr: string; starts: number; workers: Map<number, string> };

// Runs the throwaway script with a fresh home and watches, until it exits,
// every process that carries the worker marker and that home. More than
// MAX_STARTS workers is the fault itself: each is killed and the test fails.
async function runScript(env: Record<string, string>): Promise<Run> {
  const home = tempDir("oq-worker-home-");
  const { script, starts } = throwaway();
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, OPENQODEX_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 80_000,
    killSignal: "SIGKILL",
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (b: Buffer) => (out += String(b)));
  child.stderr.on("data", (b: Buffer) => (err += String(b)));
  let done = false;
  void new Promise<void>((resolve) => child.once("exit", () => resolve())).then(() => (done = true));
  const workers = new Map<number, string>();
  while (!done) {
    for (const [pid, command] of processesWith([MARKER, `OPENQODEX_HOME=${home}`])) if (pid !== child.pid) workers.set(pid, command);
    if (workers.size > MAX_STARTS) {
      for (const pid of workers.keys()) kill(pid);
      if (child.pid !== undefined) kill(child.pid);
      throw new Error(`more than ${MAX_STARTS} install workers started: ${[...workers.values()].join("\n")}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (out === "") throw new Error(`the script printed nothing: ${err}`);
  return { home, result: JSON.parse(out) as Record<string, unknown>, stderr: err, starts: readFileSync(starts, "utf8").trim().split("\n").length, workers };
}

describe("the install worker", () => {
  it("is the openqodex bin with __install, started once, and never the script that imported the resolver (1, 2, 3)", async () => {
    const run = await runScript({ OQ_TEST_WORKER: bin });
    expect(run.result).toMatchObject({ ok: true });
    expect(run.starts).toBe(1);
    expect([...run.workers.values()].map((command) => command.includes(`${bin} __install actionlint`))).toEqual([true]);
    expect(readFileSync(join(run.home, "tools", "actionlint", "install.log"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 90_000);

  it("is not started by a process that is itself a worker (4)", async () => {
    const run = await runScript({ OQ_TEST_WORKER: bin, OPENQODEX_INSTALL_WORKER: "1" });
    expect(run.result).toEqual({ ok: false, status: "not_installed", reason: "an install process does not start another install" });
    expect(run.starts).toBe(1);
    expect(run.workers.size).toBe(0);
    expect(readdirSync(join(run.home, "tools", "actionlint"))).toEqual([]);
  }, 90_000);

  it("ends the old fault at one copy: a script that names itself as the worker is started once more, and that copy starts none (1, 4)", async () => {
    const run = await runScript({ OQ_TEST_WORKER: "self" });
    expect(run.result).toEqual({ ok: false, status: "failed", reason: "install failed" });
    expect(run.starts).toBe(2);
    expect(run.workers.size).toBeLessThanOrEqual(1);
    expect(existsSync(join(run.home, "tools", "actionlint", "install.log"))).toBe(false);
  }, 90_000);

  it("is not guessed for a script that names no worker program: a plain reason instead (1, 5)", async () => {
    const run = await runScript({});
    expect(run.result).toEqual({ ok: false, status: "not_installed", reason: "no install program is set: run `npx openqodex doctor --install`" });
    expect(run.starts).toBe(1);
    expect(run.workers.size).toBe(0);
    expect(readdirSync(join(run.home, "tools", "actionlint"))).toEqual([]);
  }, 90_000);

  it("stops with one line when the install body runs in any program but the one named (6)", async () => {
    for (const named of [{}, { OQ_TEST_WORKER: bin }]) {
      const run = await runScript({ ...named, OQ_TEST_CALL: "worker" });
      const label = JSON.stringify(named);
      expect(run.result, label).toEqual({ code: 1 });
      expect(run.stderr, label).toBe("openqodex: a scanner install runs only as `openqodex __install <tool>`\n");
      expect(run.starts, label).toBe(1);
      expect(run.workers.size, label).toBe(0);
      expect(existsSync(join(run.home, "tools")), label).toBe(false);
    }
  }, 90_000);
});
