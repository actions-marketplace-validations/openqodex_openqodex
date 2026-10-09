// The temp folder helper's cleanup stops only the processes this file owns.
//
// Ways it could fail, written before the code (review of #68):
// 1. A process no test started, which only names a test folder in its
//    command line (someone's `tail -f` on a log), is killed.
// 2. A background process that inherited this file's environment and
//    outlived the command that started it (the CLI's scanner install) keeps
//    running, and writes the folder back after it is removed.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./temp-dirs.mjs";

afterAll(removeTempDirs);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function gone(pid: number): boolean {
  const end = Date.now() + 5000;
  while (alive(pid) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return !alive(pid);
}

// Starts `command` through a shell that exits at once, so the process is no
// child of this one, as a background install is once its CLI has exited.
function orphan(command: string, env: NodeJS.ProcessEnv): number {
  const r = spawnSync("sh", ["-c", `${command} >/dev/null 2>&1 & echo $!`], { env, encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no process started: ${r.stderr}`);
  return pid;
}

describe("removeTempDirs", () => {
  it("stops a background process this file started and leaves alone one it never started that names the folder (1, 2)", () => {
    const dir = tempDir("oq-cleanup-");
    const log = join(dir, "install.log");
    writeFileSync(log, "");
    const stranger = orphan(`tail -f '${log}'`, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
    const worker = orphan(`'${process.execPath}' -e 'setInterval(() => {}, 1000)'`, { ...process.env, OPENQODEX_HOME: join(dir, "home") });
    try {
      expect(alive(stranger)).toBe(true);
      expect(alive(worker)).toBe(true);
      removeTempDirs();
      expect(gone(worker)).toBe(true);
      expect(alive(stranger)).toBe(true);
    } finally {
      for (const pid of [stranger, worker]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });
});
