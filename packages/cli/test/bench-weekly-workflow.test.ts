// The weekly scanner-only benchmark (.github/workflows/bench-weekly.yml)
// keeps what it scanned only through its last steps: the trend in the job
// summary, the run's index entry and the artifact. These checks read the
// workflow as GitHub reads it.
//
// Ways it could fail, written before the change:
//   1. The hour runs out before the summary and the artifact: a slow setup
//      or scan, with no limit of its own, spends the job's timeout, and the
//      steps that keep the diagnostics never start. Every step that can run
//      before them has a timeout, and together they leave at least
//      COLLECT_MINUTES of the job's hour.
//   2. A cancel loses the saved diagnostics: a step that writes the summary,
//      the index entry or the artifact runs only when the job was not
//      cancelled. Each runs on always(), with a guard on the files it reads,
//      so it skips cleanly when there is nothing to keep.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; "timeout-minutes"?: number; with?: Record<string, unknown> };
type Job = { "timeout-minutes"?: number; steps: Step[] };
const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "..", "..", "..", ".github", "workflows", "bench-weekly.yml"), "utf8");
const workflow = parse(text) as { jobs: Record<string, Job> };
const [job] = Object.values(workflow.jobs);
const label = (s: Step) => s.name ?? s.uses ?? s.run ?? "a step";

// The minutes the trend, the index entry, the score of the full pass and
// the upload need after everything before them used its limit.
const COLLECT_MINUTES = 8;
// The steps that keep the diagnostics: they write the job summary or the
// index entry, or upload the artifact.
const collects = (s: Step) => /GITHUB_STEP_SUMMARY|publish-run\.mjs/.test(s.run ?? "") || (s.uses ?? "").startsWith("actions/upload-artifact@");

describe("the weekly scanner-only workflow", () => {
  const first = job!.steps.findIndex(collects);
  const before = job!.steps.slice(0, first);
  const collecting = job!.steps.filter(collects);

  it("finds the steps that keep the diagnostics, after the scans", () => {
    expect(first).toBeGreaterThan(0);
    expect(collecting.map(label)).toEqual(["Trend against the accepted run", "Write the run's index entry", "Score of every development pull request", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"]);
    expect(before.some((s) => /run\.mjs --mode scan/.test(s.run ?? ""))).toBe(true);
  });

  it(`leaves at least ${COLLECT_MINUTES} minutes of the job's hour for them, whatever the steps before take (1)`, () => {
    expect(job!["timeout-minutes"]).toBe(60);
    for (const s of before) expect(s["timeout-minutes"], `${label(s)} has no timeout-minutes`).toBeGreaterThan(0);
    const spent = before.reduce((sum, s) => sum + (s["timeout-minutes"] ?? 0), 0);
    expect(spent + COLLECT_MINUTES, `the steps before the summary may take ${spent} of ${job!["timeout-minutes"]} minutes`).toBeLessThanOrEqual(job!["timeout-minutes"]!);
  });

  it("runs each of them after a cancel too, skipping cleanly when there is nothing to keep (2)", () => {
    for (const s of collecting) {
      expect(s.if, label(s)).toMatch(/^\$\{\{ always\(\) && hashFiles\(/);
      expect(s.if, label(s)).not.toMatch(/cancelled\(\)/);
    }
  });
});
