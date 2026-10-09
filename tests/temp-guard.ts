// Global setup for both vitest configs. The run gets its own folder under the
// system temp folder and every test, worker and subprocess it starts writes
// its temp folders there (TMPDIR points at it). At the end the folder must be
// empty: each test file removes what it made (tests/temp-dirs.mjs). Anything
// left fails the run with its name, and the run folder is removed either way,
// so a leaking test can never fill the disk. A run folder of its own also
// keeps two runs on one machine from judging, or removing, each other's
// folders.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  // The caches kept between runs stay in the system temp folder: the
  // scanner tools of the end-to-end home and the graph acceptance clones.
  process.env.OPENQODEX_TEST_CACHE_DIR ??= tmpdir();
  const run = mkdtempSync(join(tmpdir(), "oq-test-run-"));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = run;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    // node-compile-cache is Node's own cache, which npm switches on; it lands
    // here only because TMPDIR does, and goes with the run folder.
    const left = readdirSync(run).filter((name) => name !== "node-compile-cache").sort();
    rmSync(run, { recursive: true, force: true, maxRetries: 5 });
    if (left.length > 0) {
      const shown = left.slice(0, 40).map((name) => `  ${name}`).join("\n");
      const more = left.length > 40 ? `\n  and ${left.length - 40} more` : "";
      throw new Error(`the tests left ${left.length} temp folders behind (removed now; each test file must remove its own with afterAll(removeTempDirs)):\n${shown}${more}`);
    }
  };
}
