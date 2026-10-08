// The runner decides what a run holds, so each rule that keeps a run honest
// is checked without starting a reviewer: every attempt is its own scored
// sample, a retry never lands on the first attempt's files, a failed review
// is a scored failure, a resume refuses changed settings, the bundle must be
// the one built from the tree the run names, and the Codex model comes from
// Codex's own output.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../lib/cases.mjs";
import { attemptDir, codexModelFrom, failureOf, provenanceProblems, resumeProblems, sampleRecord, treeState } from "../lib/runner.mjs";
import { loadRun } from "../score.mjs";

const job = { case: "c", config: "claude-graph-on", reviewer: "claude", graph: true, repeat: 2 };

describe("attempts", () => {
  it("gives every attempt its own folder, the first one the repeat's own", () => {
    expect(attemptDir("/r", job, 1)).toBe(join("/r", "samples", "c", "claude-graph-on", "2"));
    expect(attemptDir("/r", job, 2)).toBe(join("/r", "samples", "c", "claude-graph-on", "2-attempt2"));
    expect(attemptDir("/r", job, 2)).not.toBe(attemptDir("/r", job, 1));
  });

  it("calls a review with no report, or whose reviewer timed out, a reviewer failure, and an unread range a product result", () => {
    expect(failureOf({ code: 2, signal: null, stderr: "boom" }, null)).toMatchObject({ infra: true });
    expect(failureOf({ code: 2, signal: null, stderr: "Full review unavailable: openqodex could not start a reviewer." }, null)).toMatchObject({ infra: true, unavailable: true });
    const timedOut = { completion: { status: "incomplete", missing: ["the reviewer timed out and was stopped"] } };
    expect(failureOf({ code: 2, signal: null, stderr: "" }, timedOut)).toMatchObject({ infra: true, cause: "the reviewer timed out and was stopped" });
    const unread = { completion: { status: "incomplete", missing: ["1 changed range was not read: a.py:3"] } };
    expect(failureOf({ code: 2, signal: null, stderr: "" }, unread)).toMatchObject({ infra: false });
    expect(failureOf({ code: 0, signal: null, stderr: "" }, { completion: { status: "complete", missing: [] } })).toBeNull();
  });

  it("records a failed attempt as a sample with its cause, so it is scored and never a missing row", () => {
    const rec = sampleRecord({ job, attempt: 1, result: { code: 2, signal: null, wallMs: 900_000 }, report: null, who: null, startedAt: "t", failure: { cause: "the reviewer timed out and was stopped" }, stopped: null });
    expect(rec).toMatchObject({ case: "c", repeat: 2, attempt: 1, status: "failed", failure: "the reviewer timed out and was stopped", findings: null });
  });

  it("loads every attempt of a saved run as a sample, a failed one included", () => {
    const out = mkdtempSync(join(tmpdir(), "oq-bench-load-"));
    const spec = { id: "c", guards: "g", language: "python", framework: "none", clean: false, bugs: [{ id: "b", file: "a.py", lines: [1, 1], anchor: { line: 1, text: "x" }, mentions: ["x"], kind: ["bug"], severity: "major", found_by: ["reasoning"], truth: "t" }] };
    mkdirSync(join(out, "cases"), { recursive: true });
    writeFileSync(join(out, "cases", "c.json"), JSON.stringify(spec));
    writeFileSync(join(out, "manifest.json"), JSON.stringify({ version: 1, repeat: 1, planned: 1 }));
    for (const [n, status] of [["1", "failed"], ["1-attempt2", "complete"]]) {
      const dir = join(out, "samples", "c", "claude-graph-on", n);
      mkdirSync(join(dir, "report"), { recursive: true });
      writeFileSync(join(dir, "sample.json"), JSON.stringify({ case: "c", config: "claude-graph-on", repeat: 1, attempt: n === "1" ? 1 : 2, status }));
      if (status === "complete") writeFileSync(join(dir, "report", "report.json"), JSON.stringify({ findings: [], outside_change: [], dropped: [], completion: { status: "complete", missing: [] } }));
    }
    const run = loadRun(out);
    expect(run.samples.map((s) => s.status).sort()).toEqual(["complete", "failed"]);
  });
});

describe("resuming a run", () => {
  const manifest = {
    build: { bundleHash: "b1" },
    machine: { platform: "darwin", arch: "arm64", cpu: "M5", cpus: 15, memoryGb: 48, node: "v22.23.3" },
    reviewers: { claude: { name: "claude", version: "2.1.294", model: "m1" } },
    review: { web: "on", timeoutSeconds: 900 },
    concurrency: 1,
    caseHashes: { c: "h1" },
  };

  it("accepts the same settings and names each one that differs", () => {
    expect(resumeProblems(manifest, manifest)).toEqual([]);
    const now = {
      ...manifest,
      build: { bundleHash: "b2" },
      machine: { ...manifest.machine, cpu: "M4" },
      reviewers: { claude: { name: "claude", version: "2.1.295", model: "m2" } },
      review: { web: "off", timeoutSeconds: 600 },
      concurrency: 2,
      caseHashes: { c: "h2" },
    };
    const said = resumeProblems(manifest, now).join("\n");
    for (const word of ["CLI bundle", "machine", "claude reviewer version", "claude model", "web", "timeout", "concurrency", "case c"]) expect(said).toContain(word);
  });
});

describe("the build's provenance", () => {
  const repo = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "oq-bench-prov-")), "repo");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "one");
    return dir;
  };

  it("calls the tree clean when it matches the commit, and dirty after an edit or a new file, whatever the index holds", () => {
    const dir = repo();
    const clean = treeState(dir);
    expect(clean).toMatchObject({ dirty: false });
    expect(clean.tree).toBe(clean.commitTree);
    writeFileSync(join(dir, "b.txt"), "new\n");
    const added = treeState(dir);
    expect(added.dirty).toBe(true);
    expect(added.commit).toBe(clean.commit);
    // Staging the file does not change what the tree holds.
    git(dir, "add", "b.txt");
    expect(treeState(dir).tree).toBe(added.tree);
  });

  it("refuses a bundle that is not the one built, and a run with no record of its build", () => {
    const prov = { commit: "c1", tree: "t1", commitTree: "t1", dirty: false, bundleHash: "b1" };
    expect(provenanceProblems(prov, "b1")).toEqual([]);
    expect(provenanceProblems(prov, "b2").join("\n")).toMatch(/not the one benchmark\/build-cli.mjs built/);
    expect(provenanceProblems(null, "b1").join("\n")).toMatch(/node benchmark\/build-cli.mjs/);
  });
});

describe("the Codex model", () => {
  it("reads the model from the header Codex prints, and says unknown when there is none", () => {
    const header = "OpenAI Codex v0.161.0\n--------\nworkdir: /tmp/x\nmodel: gpt-6.1-sol\nprovider: openai\n--------\n";
    expect(codexModelFrom(header)).toBe("gpt-6.1-sol");
    expect(codexModelFrom("no header here")).toBe("unknown");
  });
});
