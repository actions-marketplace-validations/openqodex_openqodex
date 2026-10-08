// The monthly pin bump workflow (.github/workflows/pin-bump.yml) moves pins in
// the table the installer trusts, and its gate starts a scanner release from
// outside this repository. These checks read the workflow as GitHub reads it.
//
// Ways it could fail, written before the change:
//   1. A job that runs code from outside the repository (a package install,
//      the build, the gate and the scanner release it starts) holds a write
//      token, or keeps git credentials in its checkout.
//   2. The job that holds the write token installs packages, builds, runs
//      the gate, or starts any program the bump downloaded.
//   3. An action is pinned by a tag, which its owner can move, not a commit.
//   4. The workflow runs on pull_request_target or checks out a pull
//      request's head.
//   5. A step merges or approves a pull request.
//   6. The workflow reads a secret other than GITHUB_TOKEN.
// Added for the handoff between jobs:
//   7. The job that opens the pull request commits files another job made:
//      it copies or unpacks what it downloaded instead of making the bump
//      itself with the checking script.
//   8. A value from another job or from the network reaches a shell command
//      through `${{ }}`, or an environment variable carries one in.
//   9. The pull request's body or branch uses a value the script did not
//      check, or the job never checks the gate job's claim against its own.
// Added after the code review:
//  10. The job with the write token starts a program it downloaded: uv,
//      through lock-scanners.mjs, while re-locking a PyPI pin.
//  11. The lock files it takes from the gate job were written after the
//      gate started there, or are taken without --locks and its checks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; steps: Step[] };
const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "..", "..", "..", ".github", "workflows", "pin-bump.yml"), "utf8");
const workflow = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };
const writes = (job: Job) => Object.values(job.permissions ?? {}).includes("write");
const outsideCode = (job: Job) => job.steps.some((s) => /\b(pnpm|npm|npx)\b|scripts\/gate\.sh|installTool/.test(s.run ?? ""));
const writer = Object.entries(workflow.jobs).filter(([, j]) => writes(j));

describe("the pin bump workflow", () => {
  it("gives a write token to one job, which runs no code from outside the repository (1, 2)", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(writer).toHaveLength(1);
    const [name, job] = writer[0]!;
    expect(job.permissions, name).toEqual({ contents: "write", "pull-requests": "write" });
    expect(outsideCode(job), name).toBe(false);
    for (const [other, j] of Object.entries(workflow.jobs)) {
      if (outsideCode(j)) expect(writes(j), other).toBe(false);
      for (const s of j.steps.filter((x) => x.uses?.startsWith("actions/checkout@"))) expect(s.with?.["persist-credentials"], other).toBe(false);
    }
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

  it("makes the bump it commits itself, with the checking script, and copies in nothing it downloaded (7)", () => {
    const [, job] = writer[0]!;
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toMatch(/node scripts\/pin-bump\.mjs --apply "\$TOOL"/);
    expect(runs).not.toMatch(/\b(cp|mv|tar|unzip|rsync|install)\b/);
    // Every file it commits is one the script wrote.
    expect(runs).toMatch(/git add packages\/scanners\/toolchain\.json packages\/scanners\/locks \.changeset/);
  });

  it("passes no value into a shell command through ${{ }}, and only known values through the environment (8)", () => {
    const allowed = /^\$\{\{ (matrix\.tool|github\.token|runner\.temp|steps\.[a-z-]+\.outcome) \}\}(\/[A-Za-z0-9._-]+)*$/;
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const s of job.steps) {
        expect(s.run ?? "", `${name}: ${s.name ?? s.uses}`).not.toContain("${{");
        for (const [k, v] of Object.entries(s.env ?? {})) {
          if (String(v).includes("${{")) expect(String(v), `${name}: ${k}`).toMatch(allowed);
        }
      }
    }
  });

  it("builds the branch and the body from checked fields, and checks the gate job's claim against its own bump (9)", () => {
    const [, job] = writer[0]!;
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    // The version comes from the table the script wrote, and must look like one.
    expect(runs).toMatch(/\[\[ "\$version" =~ \^\[0-9\]\+\(\\\.\[0-9\]\+\)\*\$ \]\]/);
    // The gate job's word is one of two, and its sha256 must equal this job's.
    expect(runs).toMatch(/node scripts\/pin-bump\.mjs --proposal "\$TOOL"/);
    expect(runs).toMatch(/\[ "\$claimed" = "\$own" \]/);
    expect(runs).toMatch(/success\|failure/);
    // The branch, the title and the body use only these checked values.
    const used = runs
      .split("\n")
      .filter((l) => /^\s*(branch|body|result)=|gh pr create/.test(l))
      .flatMap((l) => [...l.matchAll(/\$\{?([A-Za-z_]+)/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(0);
    expect([...new Set(used)].sort()).toEqual(["TOOL", "body", "branch", "result", "sums", "version"]);
  });

  it("starts no downloaded program in the job with the write token, and takes lock files only through --locks (10, 11)", () => {
    const [, job] = writer[0]!;
    const runs = job.steps.map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/lock-scanners|\buv\b|installTool/);
    expect(runs).toMatch(/node scripts\/pin-bump\.mjs --apply "\$TOOL" --locks "\$CLAIMS\/locks" --locks-sha256 "\$locksum"/);
    const gate = workflow.jobs.gate!.steps;
    const recorded = gate.findIndex((s) => /--lock-digest "\$TOOL"/.test(s.run ?? ""));
    const uploaded = gate.findIndex((s, i) => i > recorded && s.uses?.startsWith("actions/upload-artifact@") && String(s.with?.name).startsWith("proposal-"));
    const started = gate.findIndex((s) => /\b(pnpm|npm|npx)\b|scripts\/gate\.sh/.test(s.run ?? ""));
    expect(recorded).toBeGreaterThan(-1);
    expect(uploaded).toBeGreaterThan(recorded);
    expect(started).toBeGreaterThan(uploaded);
  });
});
