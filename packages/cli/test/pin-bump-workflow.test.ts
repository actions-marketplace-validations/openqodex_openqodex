// The monthly pin bump workflow (.github/workflows/pin-bump.yml) moves pins in
// the table the installer trusts, and its gate starts a scanner release from
// outside this repository. These checks read the workflow as GitHub reads it.
//
// Ways it could fail, written before the change:
//   1. A job that runs code from the repository or from a scanner holds a
//      write token, or keeps git credentials in its checkout.
//   2. The job that holds the write token runs a script from the repository
//      or a scanner.
//   3. An action is pinned by a tag, which its owner can move, not a commit.
//   4. The workflow runs on pull_request_target or checks out a pull
//      request's head.
//   5. A step merges or approves a pull request.
//   6. The workflow reads a secret other than GITHUB_TOKEN.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; steps: Step[] };
const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "..", "..", "..", ".github", "workflows", "pin-bump.yml"), "utf8");
const workflow = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };
const runsCode = (job: Job) => job.steps.some((s) => /\b(node|pnpm|npx|npm|bash scripts)\b/.test(s.run ?? ""));

describe("the pin bump workflow", () => {
  it("gives a write token only to the job that runs no code from the repository or a scanner (1, 2)", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const writes = Object.values(job.permissions ?? {}).includes("write");
      if (runsCode(job)) {
        expect(writes, name).toBe(false);
        for (const s of job.steps.filter((x) => x.uses?.startsWith("actions/checkout@"))) expect(s.with?.["persist-credentials"], name).toBe(false);
      }
      if (writes) expect(job.permissions, name).toEqual({ contents: "write", "pull-requests": "write" });
    }
    expect(Object.values(workflow.jobs).some((j) => j.permissions?.contents === "write")).toBe(true);
  });

  it("pins every action by commit sha (3)", () => {
    for (const job of Object.values(workflow.jobs)) for (const s of job.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it("runs on a schedule or by hand only, and never checks out a pull request (4)", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(text).not.toMatch(/pull_request_target|github\.event\.pull_request|refs\/pull\//);
  });

  it("never merges or approves, and reads no secret but the workflow's own token (5, 6)", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const s of job.steps) {
        expect(s.run ?? "").not.toMatch(/gh pr (merge|review)|--auto\b|\/reviews\b|\/merge\b/);
        expect(s.uses ?? "").not.toMatch(/merge|approve/i);
      }
    }
    expect(text).not.toMatch(/secrets\./);
  });
});
