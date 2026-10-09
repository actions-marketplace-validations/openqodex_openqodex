// The run guard (tests/temp-guard.ts) fails a run that leaves a folder in its
// temp folder, except the ones a program the tests start keeps for itself.
//
// Ways it could fail, written before the code:
// 1. The folders Claude Code keeps under TMPDIR when the end-to-end tests
//    start it as the reviewer (claude-<uid>, cc-socks) fail the run, though
//    no test made them (seen on the Linux gate: claude-1001, cc-socks).
// 2. Allowing those names lets any other folder through, or the failure no
//    longer names the folder left.
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import setup from "./temp-guard.js";

// A run of the guard inside this one: setup() makes a run folder under the
// current temp folder and points TMPDIR at it; `leave` folders are made
// there, then the teardown runs. The teardown puts TMPDIR back.
function guardedRun(leave: string[]): { error: Error | null; printed: string; run: string } {
  const teardown = setup();
  const run = process.env.TMPDIR!;
  for (const name of leave) mkdirSync(join(run, name));
  let printed = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((s) => ((printed += String(s)), true));
  try {
    teardown();
    return { error: null, printed, run };
  } catch (error) {
    return { error: error as Error, printed, run };
  } finally {
    write.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("the run guard", () => {
  it("passes a run that leaves only Claude Code's own folders, names them in one line and removes the run folder (1)", () => {
    const r = guardedRun(["claude-1001", "cc-socks", "cc-socks-2"]);
    expect(r.error).toBeNull();
    expect(r.printed.trim().split("\n")).toHaveLength(1);
    expect(r.printed).toContain("cc-socks, cc-socks-2, claude-1001");
    expect(existsSync(r.run)).toBe(false);
  });

  it("fails a run that leaves one more folder, and names that one (2)", () => {
    const r = guardedRun(["claude-1001", "cc-socks", "oq-stray-folder", "claude-code"]);
    expect(r.error?.message).toMatch(/the tests left 2 temp folders behind/);
    expect(r.error?.message).toContain("  claude-code\n  oq-stray-folder");
    expect(r.error?.message).not.toContain("claude-1001");
    expect(existsSync(r.run)).toBe(false);
  });
});
