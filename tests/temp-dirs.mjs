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
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @type {string[]} */
const made = [];

// Every process a test of this file starts inherits this variable, and so
// does every process those start with the environment they were given, such
// as the CLI's background scanner installs and updates. It is how the
// cleanup knows which processes this file owns.
const OWNER_VARIABLE = "OPENQODEX_TEST_OWNER";
const owner = `${process.pid}-${randomBytes(8).toString("hex")}`;
process.env[OWNER_VARIABLE] = owner;

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
 * every process this file still owns is stopped first. One folder that
 * cannot be removed does not keep the others.
 */
export function removeTempDirs() {
  const dirs = made.splice(0);
  if (dirs.length > 0) stopOwnedProcesses();
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
 * Stops every process this file owns: the ones a test started (children of
 * this process), the ones that inherited this file's owner variable (the
 * CLI's background work, which outlives the command that started it), and
 * every descendant of those (the installers a background install runs with
 * a small environment). A process that only names a test folder in its
 * command line, such as someone's `tail -f` on a log, is never touched.
 * Repeated until none is left, for a process that started a child as it was
 * stopped.
 */
function stopOwnedProcesses() {
  for (let round = 0; round < 3; round += 1) {
    const table = processTable();
    const owned = new Set(table.filter((p) => p.pid !== process.pid && (p.owner || p.ppid === process.pid)).map((p) => p.pid));
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of table) {
        if (p.pid !== process.pid && !owned.has(p.pid) && owned.has(p.ppid)) {
          owned.add(p.pid);
          grew = true;
        }
      }
    }
    if (owned.size === 0) return;
    for (const p of table) {
      if (!owned.has(p.pid)) continue;
      // A detached process leads a group of its own, whose members are its
      // descendants: stop the whole group. Any other process alone.
      try {
        process.kill(p.pgid === p.pid ? -p.pid : p.pid, "SIGKILL");
      } catch {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {
          // It ended by itself.
        }
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

/**
 * This user's live processes with their parent and group, and whether their
 * environment holds this file's owner variable. Linux keeps them in
 * /proc/<pid>/stat and /proc/<pid>/environ; macOS prints the environment
 * after the command with `ps -E`.
 * @returns {{ pid: number, ppid: number, pgid: number, owner: boolean }[]}
 */
function processTable() {
  const mark = `${OWNER_VARIABLE}=${owner}`;
  const found = [];
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        // The fields after the command name, which may itself hold spaces
        // or parentheses: state, ppid, pgrp.
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const [, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
        found.push({ pid: Number(name), ppid: Number(ppid), pgid: Number(pgid), owner: env.includes(mark) });
      } catch {
        // Ended, or not this user's.
      }
    }
    return found;
  }
  const ps = execFileSync("ps", ["-A", "-E", "-ww", "-o", "pid=,ppid=,pgid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+) (.*)$/.exec(line);
    if (m) found.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), owner: ` ${m[4]} `.includes(` ${mark} `) });
  }
  return found;
}
