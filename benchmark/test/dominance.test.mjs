// The scanner variant of the acceptance rule (PLAN-benchmark 4.11,
// amendment A1): a scanner change that only removes candidates passes K2 by
// deterministic dominance, and only when every candidate it removes is false
// by frozen evidence (a clean control) or by a person's blind ruling through
// the review queue. Runs are written in temp folders the way run.mjs writes
// them, against the frozen planted cases' own specs, and the real commands
// read them: scanners.mjs --against, queue.mjs add --candidates, sheet and
// decide.
//
// Failure list, written before the code:
// 1. A removal whose candidate was only reviewer-dropped is accepted: a
//    reviewer that drops a candidate every time says how the reviewer
//    behaves, not that the candidate is false, so the change waits for a
//    person's ruling ("pending rulings", naming the candidate) even when
//    its review run (K4) has passed.
// 2. A clean-control candidate needs a ruling before its removal counts:
//    a candidate on a case whose spec declares the whole change clean is
//    false by construction, and the scan scorer already records it so.
// 3. One candidate ruled true does not revert the change: a person ruled it
//    a real issue the change now hides, so the change is reverted whatever
//    the other rulings say.
// 4. The redundancy guard as a share of candidates penalises every noise
//    removal (the share rises when non-duplicates leave), or a rise in one
//    case's duplicates goes unseen: K3 counts redundant candidates per case
//    and permits no rise in any case.
// 5. A scanner candidate no review raised cannot enter the review queue
//    (score.mjs writes no queue item for a scanner-only run, and the queue
//    items are built from a review's shown findings), so nobody can rule on
//    what a removal removes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { caseHash, readCase } from "../lib/cases.mjs";
import { specHashOf } from "../lib/rulings.mjs";
import { candidateIdOf } from "../lib/scan-score.mjs";
import { scanSide } from "../loop/compare.mjs";
import { scannerGuards } from "../loop/decide.mjs";
import { loadRun } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const repo = fileURLToPath(new URL("../..", import.meta.url));
const SCANNERS = fileURLToPath(new URL("../scanners.mjs", import.meta.url));
const QUEUE = fileURLToPath(new URL("../queue.mjs", import.meta.url));
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
// The commands build each case they read, so a test that runs them takes a while.
const CLI = 300_000;
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const cand = (id, token, filePath, lineStart, lineEnd, message, extra = {}) => {
  const cut = token.indexOf(":");
  return { source: token.slice(0, cut), ruleId: token.slice(cut + 1), filePath, lineStart, lineEnd, severity: "low", message, reference: null, id, token, reviewSeverity: "minor", ...extra };
};
const ran = (scanner, kept = 0) => ({ scanner, status: "ran", version: "1", rawCount: kept, keptCount: kept, durationMs: 10, resolveMs: 1, files: 1, reason: null, stages: { changedLines: 0, fixtures: 0, rules: 0, merged: 0 } });
const PACKS = [{ pack: "p/default", sha256: "a".repeat(64), bytes: 10 }];
const EXTERNAL = { toolchainHash: "t".repeat(64), semgrepPacks: PACKS, osvAdvisories: { sha256: "o".repeat(64), advisories: 0 }, scannerVersions: { semgrep: "1.94.0", bandit: "1.9.4", ruff: "0.6.9" } };
const SCANNERS_RUN = ["semgrep", "bandit", "ruff", "gitleaks"];

// The planted cases these tests use, as their live specs give them.
const DEMO = "demo-polyglot";
const CLEAN = "clean-python-feature";
const idOf = (name) => `planted/${name}@${caseHash(name).slice(0, 8)}`;

// demo-polyglot's sql-injection item (app/search.py line 14) is found by
// semgrep, the scanner its spec expects; bandit's second candidate on it is a
// duplicate. The ruff candidates sit on no truth item, or on the item's line
// with nothing of it in their words: nothing frozen says what they are.
const SQL = cand("c1", "semgrep:python.lang.security.audit.formatted-sql-query.formatted-sql-query", "app/search.py", 14, 14, "Detected possible formatted SQL query. Use parameterized queries instead.");
const SQL_BANDIT = cand("c2", "bandit:B608", "app/search.py", 14, 14, "Possible SQL injection vector through string-based query construction.");
const SQL_AGAIN = cand("c3", "semgrep:python.django.security.injection.sql.sql-injection-db-cursor-execute", "app/search.py", 14, 14, "User-controlled data in a raw SQL query: SQL injection.");
const LONG = cand("c4", "ruff:E501", "app/search.py", 11, 11, "Line too long (101 > 88)", { reference: "https://docs.astral.sh/ruff/rules/line-too-long/" });
const IMPORTS = cand("c5", "ruff:I001", "app/search.py", 1, 3, "Import block is un-sorted or un-formatted", { reference: "https://docs.astral.sh/ruff/rules/unsorted-imports/" });
const LONG_ON_SQL = cand("c6", "ruff:E501", "app/search.py", 14, 14, "Line too long (96 > 88)", { reference: "https://docs.astral.sh/ruff/rules/line-too-long/" });
// clean-python-feature: bandit's assert check in a test file, as run 752b77f saw it.
const ASSERTS = [21, 22, 23, 24, 28].map((line, i) => cand(`c${i + 1}`, "bandit:B101", "tests/test_money.py", line, line, "B101: Use of assert detected. The enclosed code will be removed when compiling to optimised byte code.", { reference: "https://bandit.readthedocs.io/en/1.9.4/plugins/b101_assert_used.html", reviewSeverity: "nitpick" }));

const renumber = (list) => list.map((c, i) => ({ ...c, id: `c${i + 1}` }));
const scanOf = (candidates) => {
  const kept = (s) => candidates.filter((c) => c.source === s).length;
  return { candidates: renumber(candidates), scanners: SCANNERS_RUN.map((s) => ran(s, kept(s))), fixturesDropped: 0, secretFingerprints: [], projects: [], selection: SCANNERS_RUN.map((scanner) => ({ scanner, wanted: true, paths: ["app/search.py", "tests/test_money.py"], projects: [""], skip: null })), trail: [] };
};

// A run folder as run.mjs writes one: the manifest, the specs it scored
// against, and each sample's sample.json and report files. `cases` maps a
// case name to its candidates, and, for a review run, the report and
// submission the review saved.
function writeRun(dir, { mode = "scan", cases, commit = "a".repeat(40), scanMs = 4000 }) {
  const config = mode === "scan" ? "scan" : "claude-graph-on";
  const names = Object.keys(cases).sort();
  const hashes = Object.fromEntries(names.map((n) => [n, caseHash(n)]));
  const jobs = names.map((n) => ({ jobId: `${idOf(n)}/${config}/1`, caseId: idOf(n), config, repeat: 1 }));
  const manifest = { version: 3, runId: basename(dir), mode, path: "laptop", suite: "planted", split: "dev", build: { commit, short: commit.slice(0, 7), dirty: false, cliVersion: "0.14.0" }, ...(mode === "review" ? { reviewers: { claude: { name: "claude", model: "claude-opus-5-5" } } } : {}), cases: names, caseIds: names.map(idOf), caseHashes: hashes, configs: [config], repeat: 1, jobs, external: EXTERNAL };
  write(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const n of names) {
    write(join(dir, "cases", `${n}.json`), readFileSync(join(repo, "benchmark/cases", n, "case.json")));
    const sample = join(dir, "samples", n, config, "1");
    const { candidates, report = null, submission = null } = Array.isArray(cases[n]) ? { candidates: cases[n] } : cases[n];
    write(join(sample, "sample.json"), JSON.stringify({ jobId: `${idOf(n)}/${config}/1`, case: n, config, repeat: 1, attempt: 1, wallMs: scanMs + 500, status: "complete", timings: { scan_ms: scanMs } }));
    write(join(sample, "report", "scan.json"), JSON.stringify(scanOf(candidates)));
    if (report) write(join(sample, "report", "report.json"), JSON.stringify(report));
    if (submission) write(join(sample, "report", "submission.json"), JSON.stringify(submission));
  }
  return dir;
}

// A review that raised the SQL candidate and dropped the line-length one.
const finding = (c) => ({ origin: "agent", severity: "critical", category: "security", confidence: 0.9, file_path: c.filePath, line_number: c.lineStart, line_end: c.lineEnd, title: "SQL injection in the search", problem: "The query is built from the raw name.", consequence: "Anyone can read the database.", fix: "Pass it as a parameter.", suggested_change: null, source: c.token, candidate: c.id });
const reviewOf = (raised, dropped) => ({ version: 1, kind: "review", verdict: "failed", findings: raised.map(finding), outside_change: [], dropped: dropped.map((c) => ({ candidate: c, reason: "Line length is style, not a defect in this change." })), completion: { status: "complete", missing: [], reviewer: { duration_ms: 1000, usage: { cost_usd: 0.01 } } } });

// The queue folder a person rules in: people.json names who may rule.
function queueFolder(root) {
  const q = join(root, "queue");
  write(join(q, "people.json"), JSON.stringify({ v: 1, people: ["Pat Example"] }));
  return q;
}
const rule = (q, status, candidate, caseName = DEMO) => node(QUEUE, ["decide", status, candidateIdOf(idOf(caseName), candidate).slice(0, 12), "--by", "Pat Example", "--queue", q]);

// The scanner ledger line of a proposed change, with its review run (K4) result.
const ledgerOf = (root, { id = "SC-0901", base, candidate, k4 = { required: true, pass: null, decision: null, runId: null } }) => {
  const path = join(root, "scanner.jsonl");
  write(path, `${JSON.stringify({ v: 1, id, at: "2026-10-11T00:00:00Z", event: "decided", status: "proposed", task: "test", pr: null, kind: "adapter-flags", hypothesis: "h", baselineRunId: `local:${basename(base)}`, candidateRunId: `local:${basename(candidate)}`, look: 1, alpha: 0.025, acceptableLoss: { scanMsP50: 0.2 }, k4, decision: "inconclusive-revert", decidedBy: null })}\n`);
  return path;
};

const against = (candidate, base, ...more) => {
  const r = node(SCANNERS, [candidate, "--against", base, "--json", ...more]);
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = null;
  }
  return { ...r, doc, acceptance: doc?.comparedWith?.acceptance ?? null };
};

describe("a removal whose candidate was only reviewer-dropped is pending, never accepted", () => {
  const root = tempDir("oq-bench-dominance-");
  const base = writeRun(join(root, "base"), { cases: { [DEMO]: [SQL, LONG] } });
  const after = writeRun(join(root, "after"), { cases: { [DEMO]: [SQL] } });
  const review = writeRun(join(root, "review"), { mode: "review", cases: { [DEMO]: { candidates: [SQL, LONG], report: reviewOf([{ ...SQL, id: "c1" }], [{ ...LONG, id: "c2" }]) } } });
  const q = queueFolder(root);

  it("queues the dropped candidate for a person, and decides the removal as pending rulings that name it, even with its review run passed", () => {
    const added = node(QUEUE, ["add", "--candidates", review, "--queue", q]);
    expect(added.status, added.stderr).toBe(0);
    const items = readJsonl(join(q, "planted.jsonl"));
    // The dropped candidate is in the queue; the raised one, a frozen hit, is not.
    expect(items.map((i) => i.findingId)).toEqual([candidateIdOf(idOf(DEMO), LONG)]);
    expect(items[0]).toMatchObject({ kind: "candidate", caseId: idOf(DEMO), file: "app/search.py", lines: [11, 11], asks: ["real"] });
    expect(items[0].occurrences.map((o) => o.disposition)).toEqual(["dropped"]);

    const ledger = ledgerOf(root, { base, candidate: after, k4: { required: true, pass: true, decision: "accepted", runId: "RC-0901" } });
    const r = against(after, base, "--decisions", join(q, "decisions.jsonl"), "--change", "SC-0901", "--ledger", ledger);
    expect(r.status, r.stderr).toBe(0);
    expect(r.acceptance.decision).toBe("pending-rulings");
    expect(r.acceptance.k2.pass).toBeNull();
    expect(r.acceptance.k2.pending.map((c) => c.candidateId)).toEqual([candidateIdOf(idOf(DEMO), LONG)]);
    const text = node(SCANNERS, [after, "--against", base, "--decisions", join(q, "decisions.jsonl"), "--change", "SC-0901", "--ledger", ledger]);
    expect(text.stdout).toMatch(/pending rulings/i);
    expect(text.stdout).toContain(candidateIdOf(idOf(DEMO), LONG).slice(0, 12));
  }, CLI);

  it("still waits when a person rules it a different issue from the truth item it sits on, which says nothing of whether it is real", () => {
    const base2 = writeRun(join(root, "base2"), { cases: { [DEMO]: [SQL, LONG_ON_SQL] } });
    const after2 = writeRun(join(root, "after2"), { cases: { [DEMO]: [SQL] } });
    const q2 = join(root, "queue2");
    write(join(q2, "people.json"), JSON.stringify({ v: 1, people: ["Pat Example"] }));
    expect(node(QUEUE, ["add", "--candidates", base2, "--queue", q2]).status).toBe(0);
    const item = readJsonl(join(q2, "planted.jsonl"))[0];
    expect(item).toMatchObject({ findingId: candidateIdOf(idOf(DEMO), LONG_ON_SQL), asks: ["real", "match"], truth: { id: "sql-injection" } });
    const ruled = rule(q2, "different-issue", LONG_ON_SQL);
    expect(ruled.status, ruled.stderr).toBe(0);
    const r = against(after2, base2, "--decisions", join(q2, "decisions.jsonl"));
    expect(r.acceptance.decision).toBe("pending-rulings");
  }, CLI);
});

describe("a clean-control candidate counts as frozen false without a ruling", () => {
  const root = tempDir("oq-bench-dominance-");
  const base = writeRun(join(root, "base"), { cases: { [CLEAN]: ASSERTS, [DEMO]: [SQL, SQL_BANDIT] } });
  const after = writeRun(join(root, "after"), { cases: { [CLEAN]: [], [DEMO]: [SQL, SQL_BANDIT] } });
  const none = join(root, "no-rulings", "decisions.jsonl");

  it("passes K2 by dominance with no ruling at all, and waits only for the review run", () => {
    const r = against(after, base, "--decisions", none);
    expect(r.status, r.stderr).toBe(0);
    expect(r.acceptance.k1.pass).toBe(true);
    expect(r.acceptance.k2).toMatchObject({ by: "dominance", pass: true, pending: [], ruledTrue: [] });
    expect(r.acceptance.k2.frozenFalse).toHaveLength(5);
    expect(r.acceptance.k3.pass).toBe(true);
    expect(r.acceptance.k4).toMatchObject({ required: true, pass: null });
    expect(r.acceptance.decision).toBe("pending-k4");
  }, CLI);

  it("keeps the change once the record holds a passed review run", () => {
    const ledger = ledgerOf(root, { base, candidate: after, k4: { required: true, pass: true, decision: "accepted", runId: "RC-0902" } });
    const r = against(after, base, "--decisions", none, "--change", "SC-0901", "--ledger", ledger);
    expect(r.status, r.stderr).toBe(0);
    expect(r.acceptance.decision).toBe("keep");
  }, CLI);
});

describe("one candidate ruled true reverts the change", () => {
  const root = tempDir("oq-bench-dominance-");
  const base = writeRun(join(root, "base"), { cases: { [DEMO]: [SQL, LONG, IMPORTS] } });
  const after = writeRun(join(root, "after"), { cases: { [DEMO]: [SQL] } });

  it("waits for both rulings, passes K2 by dominance when both are false, and reverts when one is true", () => {
    const q = queueFolder(root);
    expect(node(QUEUE, ["add", "--candidates", base, "--queue", q]).status).toBe(0);
    const decisions = join(q, "decisions.jsonl");
    const waiting = against(after, base, "--decisions", decisions);
    expect(waiting.acceptance.decision).toBe("pending-rulings");
    expect(waiting.acceptance.k2.pending.map((c) => c.candidateId).sort()).toEqual([candidateIdOf(idOf(DEMO), LONG), candidateIdOf(idOf(DEMO), IMPORTS)].sort());

    expect(rule(q, "false", LONG).status).toBe(0);
    expect(against(after, base, "--decisions", decisions).acceptance.decision).toBe("pending-rulings");
    expect(rule(q, "false", IMPORTS).status).toBe(0);
    const passed = against(after, base, "--decisions", decisions);
    expect(passed.status).toBe(0);
    expect(passed.acceptance.k2).toMatchObject({ by: "dominance", pass: true });
    expect(passed.acceptance.k2.ruledFalse).toHaveLength(2);
    expect(passed.acceptance.decision).toBe("pending-k4");

    // The ruled candidates leave the queue when it is refreshed; then a
    // person changes their mind on one: it is a real issue the change hides.
    expect(node(QUEUE, ["add", "--candidates", base, "--queue", q]).status).toBe(0);
    expect(readJsonl(join(q, "planted.jsonl"))).toEqual([]);
    expect(rule(q, "true", IMPORTS).status).toBe(0);
    const reverted = against(after, base, "--decisions", decisions);
    expect(reverted.status).toBe(1);
    expect(reverted.acceptance.decision).toBe("revert");
    expect(reverted.acceptance.k2.ruledTrue.map((c) => c.candidateId)).toEqual([candidateIdOf(idOf(DEMO), IMPORTS)]);
  }, CLI);
});

describe("a candidate ruled false under spec A leaves the removal pending under spec B", () => {
  const root = tempDir("oq-bench-dominance-");
  // Spec B revises the case: it lists an issue on the line the ruff candidate sits on.
  const reviseSpec = (dir) => {
    const path = join(dir, "cases", `${DEMO}.json`);
    const spec = JSON.parse(readFileSync(path, "utf8"));
    const like = spec.bugs.find((b) => b.id === "pagination-off-by-one");
    spec.bugs.push({ ...like, id: "relative-db-path", file: "app/search.py", lines: [11, 11], anchor: { line: 11, text: "sqlite3.connect" }, mentions: ["database path"], truth: "The database path is relative to the folder the server starts in." });
    write(path, JSON.stringify(spec));
    return dir;
  };
  const baseA = writeRun(join(root, "base-a"), { cases: { [DEMO]: [SQL, LONG] } });
  const afterA = writeRun(join(root, "after-a"), { cases: { [DEMO]: [SQL] } });
  const baseB = reviseSpec(writeRun(join(root, "base-b"), { cases: { [DEMO]: [SQL, LONG] } }));
  const afterB = reviseSpec(writeRun(join(root, "after-b"), { cases: { [DEMO]: [SQL] } }));

  it("counts the false ruling under the spec it was made on, and refuses it, with the reason, under the revised one", () => {
    const q = queueFolder(root);
    expect(node(QUEUE, ["add", "--candidates", baseA, "--queue", q]).status).toBe(0);
    expect(rule(q, "false", LONG).status).toBe(0);
    const decisions = join(q, "decisions.jsonl");
    expect(readJsonl(decisions)[0].target.specHash).toMatch(/^[0-9a-f]{64}$/);

    expect(against(afterA, baseA, "--decisions", decisions).acceptance.decision).toBe("pending-k4");
    const b = against(afterB, baseB, "--decisions", decisions);
    expect(b.status, b.stderr).toBe(0);
    expect(b.acceptance.decision).toBe("pending-rulings");
    const pending = b.acceptance.k2.pending;
    expect(pending.map((c) => c.candidateId)).toEqual([candidateIdOf(idOf(DEMO), LONG)]);
    expect(pending[0].refused).toEqual([{ line: 1, why: expect.stringMatching(/another version of the case's spec/) }]);
  }, CLI);
});

describe("K3 passes when no case's duplicate count rises and fails when one does", () => {
  const root = tempDir("oq-bench-dominance-");
  // The parent: two candidates on one SQL injection (one a duplicate) and the five asserts on the clean control.
  const base = writeRun(join(root, "base"), { cases: { [CLEAN]: ASSERTS, [DEMO]: [SQL, SQL_BANDIT] } });
  const noise = writeRun(join(root, "noise"), { cases: { [CLEAN]: [], [DEMO]: [SQL, SQL_BANDIT] } });
  const more = writeRun(join(root, "more"), { cases: { [CLEAN]: ASSERTS, [DEMO]: [SQL, SQL_BANDIT, SQL_AGAIN] } });
  const side = (dir) => scanSide({ loaded: loadRun(dir) });

  it("holds when a noise removal raises the duplicates' share of candidates but no case's count", () => {
    const g = scannerGuards({ base: side(base), cand: side(noise) });
    expect(g.redundancy.share).toEqual({ parent: { hit: 1, of: 7 }, candidate: { hit: 1, of: 2 } });
    expect(g.redundancy).toMatchObject({ pass: true, rose: [] });
    expect(g.pass).toBe(true);
  });

  it("fails, naming the case, when one case gains a duplicate", () => {
    const g = scannerGuards({ base: side(base), cand: side(more) });
    expect(g.redundancy.pass).toBe(false);
    expect(g.redundancy.rose).toEqual([{ caseId: idOf(DEMO), parent: 1, candidate: 2 }]);
    expect(g.pass).toBe(false);
  });
});

describe("a run's case name leads a build outside the temp folder", () => {
  const root = tempDir("oq-bench-dominance-");
  const run = writeRun(join(root, "run"), { cases: { [DEMO]: [SQL, LONG] } });
  // The manifest names one more case, by a path out of the folder its build is joined to.
  const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  const escape = "../../escape";
  write(join(run, "manifest.json"), JSON.stringify({ ...manifest, cases: [...manifest.cases, escape], caseIds: [...manifest.caseIds, `planted/${escape}@00000000`], jobs: [...manifest.jobs, { jobId: `planted/${escape}@00000000/scan/1`, caseId: `planted/${escape}@00000000`, config: "scan", repeat: 1 }] }));
  const q = queueFolder(root);

  it("refuses the run in one plain line before any path is built from the name", () => {
    const r = node(QUEUE, ["add", "--candidates", run, "--queue", q]);
    expect(r.status).toBe(2);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/names the case "\.\.\/\.\.\/escape", which is not a planted case name/);
    expect(existsSync(join(q, "planted.jsonl"))).toBe(false);
  });
});

describe("a scanner candidate no review raised cannot enter the review queue", () => {
  const root = tempDir("oq-bench-dominance-");
  const run = writeRun(join(root, "2026-10-12-abcdef1-scan"), { cases: { [CLEAN]: ASSERTS, [DEMO]: [SQL, LONG, LONG_ON_SQL] }, commit: "abcdef1".padEnd(40, "0") });
  const q = queueFolder(root);

  it("queues a scanner-only run's unresolved candidates with what a person rules from, shows them blind, and records a person's ruling only", () => {
    const added = node(QUEUE, ["add", "--candidates", run, "--queue", q]);
    expect(added.status, added.stderr).toBe(0);
    const items = readJsonl(join(q, "planted.jsonl"));
    // Not the frozen hit, not the clean control's frozen false candidates: the two ruff candidates.
    expect(items.map((i) => i.findingId).sort()).toEqual([candidateIdOf(idOf(DEMO), LONG), candidateIdOf(idOf(DEMO), LONG_ON_SQL)].sort());
    const long = items.find((i) => i.lines[0] === 11);
    expect(long).toMatchObject({ kind: "candidate", rule: { scanner: "ruff", id: "E501", token: "ruff:E501", reference: "https://docs.astral.sh/ruff/rules/line-too-long/" }, message: "Line too long (101 > 88)", asks: ["real"], truth: null });
    // The code at the candidate's line, from the case built from the live tree.
    expect(long.evidence.text).toBe('    conn = sqlite3.connect("items.db")');
    expect(long.occurrences).toEqual([{ run: basename(run), build: "abcdef1", commit: "abcdef1".padEnd(40, "0"), config: "scan", repeat: 1, outcome: "unresolved", disposition: "unreviewed" }]);

    const sheet = node(QUEUE, ["sheet", "planted", "--seed", "7", "--queue", q]);
    expect(sheet.status, sheet.stderr).toBe(0);
    expect(sheet.stdout).toMatch(/Scanner candidate: ruff:E501/);
    expect(sheet.stdout).toContain("Line too long (101 > 88)");
    expect(sheet.stdout).toContain('conn = sqlite3.connect("items.db")');
    expect(sheet.stdout).not.toContain(basename(run));
    expect(sheet.stdout).not.toContain("abcdef1");

    const refused = node(QUEUE, ["decide", "false", long.findingId.slice(0, 12), "--by", "Claude", "--queue", q]);
    expect(refused.status).toBe(2);
    // A candidate is ruled on its own spec version, one by one: an issue ruling would not count for it.
    const grouped = node(QUEUE, ["decide", "consolidate", ...items.map((i) => i.findingId.slice(0, 12)), "--by", "Pat Example", "--queue", q]);
    expect(grouped.status).toBe(2);
    expect(grouped.stderr).toMatch(/never consolidated/);
    expect(readJsonl(join(q, "decisions.jsonl"))).toEqual([]);
    expect(rule(q, "false", LONG).status).toBe(0);
    expect(rule(q, "different-issue", LONG_ON_SQL).status).toBe(0);
    const lines = readJsonl(join(q, "decisions.jsonl"));
    expect(lines.map((l) => [l.target, l.status, l.by])).toEqual([
      [{ kind: "finding", findingId: candidateIdOf(idOf(DEMO), LONG), candidate: true, specHash: specHashOf(readCase(DEMO)) }, "false", "Pat Example"],
      [{ kind: "match", findingId: candidateIdOf(idOf(DEMO), LONG_ON_SQL), truthId: "sql-injection", candidate: true, specHash: specHashOf(readCase(DEMO)) }, "different-issue", "Pat Example"],
    ]);
    // The answered question leaves the queue; the open one stays.
    expect(node(QUEUE, ["add", "--candidates", run, "--queue", q]).status).toBe(0);
    expect(readJsonl(join(q, "planted.jsonl")).map((i) => [i.findingId, i.asks])).toEqual([[candidateIdOf(idOf(DEMO), LONG_ON_SQL), ["real"]]]);
  }, CLI);
});
