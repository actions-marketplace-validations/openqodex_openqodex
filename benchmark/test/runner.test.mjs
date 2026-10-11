// The runner decides what a run holds, so each rule that keeps a run honest
// is checked without starting a reviewer: every attempt is its own scored
// sample, a retry never lands on the first attempt's files, a failed review
// is a scored failure, a resume refuses changed settings, the bundle must be
// the one built from the tree the run names, and the Codex model comes from
// Codex's own output. The run folder rules (one plan per folder, one runner
// at a time, a crashed attempt kept) are checked on executeRun, the code
// run.mjs runs, with the review step, which would call a model, replaced.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git } from "../lib/cases.mjs";
import { attemptDir, codexModelFrom, executeRun, failureOf, lockRun, planJobs, provenanceProblems, resumeProblems, runManifest, sampleRecord, takeOverStale, treeState } from "../lib/runner.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

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
    const out = tempDir("oq-bench-load-");
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
    const dir = join(tempDir("oq-bench-prov-"), "repo");
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

// --- the run folder ---

const ID = "planted/one@cdcdcdcd";
const oneSpec = { id: "one", guards: "g", language: "python", framework: "none", clean: false, bugs: [{ id: "sqli", file: "app.py", lines: [4, 4], anchor: { line: 4, text: "x" }, mentions: ["sql"], kind: ["security"], severity: "critical", found_by: ["reasoning"], truth: "t" }] };
const hitReport = { findings: [{ origin: "agent", severity: "critical", category: "security", confidence: 0.9, file_path: "app.py", line_number: 4, line_end: 4, title: "SQL injection", problem: "p", consequence: "c", fix: "f" }], outside_change: [], dropped: [], completion: { status: "complete", missing: [], reviewer: { usage: { cost_usd: 0.3 } } } };

// The plan, the manifest and the spec copy run.mjs gives executeRun for one case.
function runInputs(repeat = 1) {
  const root = tempDir("oq-bench-folder-");
  const specFile = join(root, "one.json");
  writeFileSync(specFile, JSON.stringify(oneSpec));
  const { jobs } = planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on"], repeat });
  const manifest = runManifest({ startedAt: "2026-10-10T10:00:00.000Z", settings: { cases: ["one"], caseIds: [ID], configs: ["claude-graph-on"], repeat }, jobs });
  return { out: join(root, "run"), jobs, manifest, copies: [[specFile, "cases/one.json"]] };
}

// One attempt as the runner leaves it: its folder, its sample and, when the review wrote one, its report.
function saveAttempt(out, job, attempt, report) {
  const dir = attemptDir(out, job, attempt);
  mkdirSync(join(dir, "report"), { recursive: true });
  writeFileSync(join(dir, "sample.json"), JSON.stringify(sampleRecord({ job, attempt, result: { code: report ? 0 : 2, signal: null, wallMs: 1000 }, report, who: null, startedAt: "t", failure: null, stopped: null })));
  if (report) writeFileSync(join(dir, "report", "report.json"), JSON.stringify(report));
}

describe("a plan with one job twice counts that job twice", () => {
  it("refuses a plan whose configurations or cases repeat (--graph on,on, --cases one,one)", () => {
    expect(() => planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on", "on"], repeat: 1 })).toThrow(/twice/);
    expect(() => planJobs({ cases: ["one", "one"], caseIds: { one: ID }, reviewers: ["claude"], graph: ["on"], repeat: 1 })).toThrow(/twice/);
    expect(planJobs({ cases: ["one"], caseIds: { one: ID }, reviewers: ["claude", "codex"], graph: ["off", "on"], repeat: 2 }).jobs).toHaveLength(8);
  });
});

describe("a resumed run reruns a crashed first attempt in its folder, so a later success replaces the crash", () => {
  it("keeps a first-attempt folder that never got its sample.json, runs the job again as attempt 2, and scores the crash as the first attempt", async () => {
    const { out, jobs, manifest, copies } = runInputs();
    // The runner was killed after the review started: the folder exists, sample.json does not.
    await executeRun({ out, manifest, jobs, copies, runJob: async (job) => {
      mkdirSync(attemptDir(out, job, 1), { recursive: true });
      writeFileSync(join(attemptDir(out, job, 1), "stderr.txt"), "killed\n");
    } });
    const ran = [];
    await executeRun({ out, manifest: null, resume: true, jobs, copies, runJob: async (job, attempt) => {
      ran.push([job.jobId, attempt]);
      saveAttempt(out, job, attempt, hitReport);
    } });
    expect(ran).toEqual([[jobs[0].jobId, 2]]);
    expect(readdirSync(attemptDir(out, jobs[0], 1))).toEqual(["stderr.txt"]);
    const { score } = scoreRun(loadRun(out));
    expect(score.byConfig["claude-graph-on"].population).toMatchObject({ planned: 1, failed: 1, complete: 0, retries: 1 });
    expect(score.byConfig["claude-graph-on"].issueRecall.all).toEqual({ hit: 0, of: 1 });
  });
});

describe("two runners share one run folder, or a restart replaces a crashed run's plan", () => {
  it("refuses a second runner on the same empty --out while the first holds it", async () => {
    const a = runInputs();
    let release;
    const held = new Promise((r) => (release = r));
    const first = executeRun({ out: a.out, manifest: a.manifest, jobs: a.jobs, copies: a.copies, runJob: () => held });
    // The first runner has taken the folder before its first review.
    for (let i = 0; i < 50 && !existsSync(join(a.out, "manifest.json")); i++) await new Promise((r) => setTimeout(r, 10));
    const written = readFileSync(join(a.out, "manifest.json"), "utf8");
    const other = { ...a.manifest, started_at: "2026-10-10T11:00:00.000Z" };
    await expect(executeRun({ out: a.out, manifest: other, jobs: a.jobs, copies: a.copies, runJob: async () => {} })).rejects.toThrow(/in use by another run/);
    await expect(executeRun({ out: a.out, manifest: null, resume: true, jobs: a.jobs, copies: a.copies, runJob: async () => {} })).rejects.toThrow(/in use by another run/);
    release();
    await first;
    expect(JSON.parse(readFileSync(join(a.out, "manifest.json"), "utf8")).started_at).toBe(JSON.parse(written).started_at);
  });

  it("refuses a new run in a folder whose run crashed before any sample, so its plan is never replaced", async () => {
    const a = runInputs();
    mkdirSync(a.out, { recursive: true });
    writeFileSync(join(a.out, "manifest.json"), JSON.stringify(a.manifest));
    // The crashed runner's lock: a process that has ended.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(a.out, ".run.lock"), `${dead}\n`);
    const before = readFileSync(join(a.out, "manifest.json"), "utf8");
    await expect(executeRun({ out: a.out, manifest: { ...a.manifest, started_at: "2026-10-10T12:00:00.000Z" }, jobs: a.jobs, copies: a.copies, runJob: async () => {} })).rejects.toThrow(/already holds a run/);
    expect(readFileSync(join(a.out, "manifest.json"), "utf8")).toBe(before);
    // With --resume the stale lock is taken over and the run goes on.
    const ran = [];
    await executeRun({ out: a.out, manifest: null, resume: true, jobs: a.jobs, copies: a.copies, runJob: async (job, attempt) => ran.push(attempt) });
    expect(ran).toEqual([1]);
    expect(existsSync(join(a.out, ".run.lock"))).toBe(false);
  });

  it("never takes over a lock that is being written (empty), or one a live runner put in place after the dead holder was read", () => {
    const out = tempDir("oq-bench-lock-");
    const lock = join(out, ".run.lock");
    writeFileSync(lock, "");
    expect(() => lockRun(out)).toThrow(/in use by another run/);
    expect(readFileSync(lock, "utf8")).toBe("");
    // The holder read as dead, but by the takeover a live runner's lock is there: it stays.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lock, `${process.pid}\n`);
    expect(takeOverStale(lock, dead)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    // Still the dead holder's: it is taken away, and the folder can be locked.
    writeFileSync(lock, `${dead}\n`);
    expect(takeOverStale(lock, dead)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    const release = lockRun(out);
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
    release();
    expect(readdirSync(out)).toEqual([]);
  });
});
