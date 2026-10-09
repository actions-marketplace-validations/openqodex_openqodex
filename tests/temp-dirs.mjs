// Temp folders for tests, removed by the test file that made them:
//
//   import { afterAll } from "vitest";
//   import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";
//   afterAll(removeTempDirs);
//   const dir = tempDir("oq-thing-");
//
// Each test file loads its own copy of this module, so the list holds the
// folders of that file only. A file that makes folders and never removes them
// fails the run's global check (tests/temp-guard.ts).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @type {string[]} */
const made = [];

/**
 * A new empty folder under the temp folder, named `prefix` and six random
 * characters; removed by removeTempDirs().
 * @param {string} prefix
 * @returns {string}
 */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * Removes every folder tempDir() made so far in this test file. A scanner
 * install or update the CLI started in the background outlives the command
 * that started it, and would write into its home after the home is gone, so
 * every process still working in one of the folders is stopped first. One
 * folder that cannot be removed does not keep the others.
 */
export function removeTempDirs() {
  const dirs = made.splice(0);
  stopProcessesIn(dirs);
  const failed = [];
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      failed.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed.length > 0) throw new Error(`could not remove ${failed.length} temp folders:\n${failed.join("\n")}`);
}

/**
 * A cache kept between runs on purpose (the scanner tools, cloned repos): in
 * the system temp folder the run started with, never in the run's own temp
 * folder, which the global check empties at the end.
 * @param {string} name
 * @returns {string}
 */
export function cacheFolder(name) {
  return join(process.env.OPENQODEX_TEST_CACHE_DIR ?? tmpdir(), name);
}

/**
 * Stops every process that names a path in one of `dirs` in its command
 * line or its environment: the background install itself (its
 * OPENQODEX_HOME) and the installers it runs in groups of their own with a
 * small environment (uv, pip, gem, npm, whose arguments name the home).
 * Repeated until none is left, for a process that started a child as it was
 * stopped.
 * @param {string[]} dirs
 */
function stopProcessesIn(dirs) {
  if (dirs.length === 0) return;
  const roots = new Set(dirs);
  for (const dir of dirs) {
    try {
      roots.add(realpathSync(dir));
    } catch {
      // Already gone.
    }
  }
  // A path ends at a slash, a space (macOS prints everything space
  // separated), a NUL (Linux keeps the parts NUL separated) or the end.
  const names = (text) => [...roots].some((r) => text.includes(`${r}/`) || text.includes(`${r} `) || text.includes(`${r}\0`) || text.endsWith(r));
  for (let round = 0; round < 3; round += 1) {
    const pids = processesNaming(names).filter((pid) => pid !== process.pid);
    if (pids.length === 0) return;
    for (const pid of pids) {
      // A detached process leads a group of its own; stop the whole group,
      // or the process alone when it leads none.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // It ended by itself.
        }
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

/**
 * The pids of this user's live processes whose command line and
 * environment `match` accepts. Linux keeps them in /proc/<pid>/cmdline and
 * /proc/<pid>/environ; macOS prints the environment after the command with
 * `ps -E`.
 * @param {(text: string) => boolean} match
 * @returns {number[]}
 */
function processesNaming(match) {
  const found = [];
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        if (match(`${readFileSync(`/proc/${name}/cmdline`, "utf8")}\0${readFileSync(`/proc/${name}/environ`, "utf8")}`)) found.push(Number(name));
      } catch {
        // Ended, or not this user's.
      }
    }
    return found;
  }
  const ps = execFileSync("ps", ["-A", "-E", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m && match(m[2])) found.push(Number(m[1]));
  }
  return found;
}
