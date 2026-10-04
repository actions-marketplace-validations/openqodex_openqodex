// The GitHub Action (action.yml at the root) runs the scanners only.
//
// Ways it could fail, written before the code:
//  1. A tool failure (exit 2) fails the job.
//  2. Its output does not say, first, that it is a scanner run and not a review.
//  3. Findings at or above block_on_severity (exit 1) no longer fail the job.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; if?: string; run?: string };
const action = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "action.yml"), "utf8")) as { runs: { steps: Step[] } };
const step = (name: string) => action.runs.steps.find((s) => s.name === name);

describe("the GitHub Action", () => {
  it("1, 3. fails the job on exit 1 only", () => {
    const fail = step("Fail on blocking findings");
    expect(fail?.if).toBe("steps.scan.outputs.exit-code == '1'");
    expect(fail?.run).toContain("exit 1");
  });

  it("2. says first that it runs the scanners only and is not a review", () => {
    const scan = step("Scan the change");
    const first = scan?.run?.split("\n").find((l) => l.trim() !== "");
    expect(first).toMatch(/^echo "OpenQodex scanners only: .*not a review/);
  });
});
