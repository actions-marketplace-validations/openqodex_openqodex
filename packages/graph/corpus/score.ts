// Scores the code graph against the correctness corpus (PLAN.md 3.6).
//
// Each case folder holds `base/` (the files of the base commit), `change/`
// (the files the change writes over the base), an optional `delete.txt`
// (paths the change deletes, one per line), `expected.json` and a README
// that names the real failure the case guards. A case is scored by building
// a real git repository from those files in a temp folder, taking the
// uncommitted change with getChange, building the graph against the base
// commit, running detectImpact, and comparing the answer with expected.json.
//
// The scores, each a count of hits over a count of checks (no checks reads
// as 1):
// - precision: certain sites into the case's touched, removed and expected
//   target symbols that expected.json lists as certain callers.
// - recall: expected callers found at their tier (certain and likely apart),
//   export changes with their consumers, removed symbols, moved symbols.
// - validity: sites of every edge, import and miss that pass validateEvidence.
// - gaps: expected unknowns found with their cause, and floor flags as expected.
// - cuts: expected cuts found with their omitted count, or null.
// - controls: negative controls that must hold (a consumer never broken, a
//   call classified external and never a gap or an edge, every file read).
// The gate is 1 on every score.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getChange } from "@openqodex/core";
import type { ImpactSite, ImpactSummary } from "@openqodex/core";
import { buildGraph, detectImpact, validateEvidence } from "../src/index.js";
import type { EvidenceKind, Graph } from "../src/index.js";
import { scoreFrameworks } from "./frameworks.js";
import type { FrameworkExpected } from "./frameworks.js";

// A symbol is `<file>#<name>` or `<file>#<Owner>.<name>`, with an optional
// `@<line>` when two definitions of one file share the name. A site is
// `<file>:<line>`.
export type Expected = {
  guards: string; // the failure the case guards, in one line: the test name
  knownFailure?: string; // what the graph does wrong today, when the case fails because of it
  build?: { maxFileBytes?: number }; // build settings the case needs
  callers?: { to: string; site: string; tier: "certain" | "likely"; note?: string }[];
  notCertain?: { to: string; site: string }[];
  exports?: { file: string; name: string; change: "removed" | "retargeted"; consumers: string[] }[];
  removed?: string[]; // removed and not moved
  moved?: { from: string; to: string; renamed: boolean }[];
  unknowns?: { file: string; line: number; cause: string; scope?: "file" | "project" }[];
  floor?: Record<string, boolean>;
  cuts?: { by: string; omitted: number | null }[];
  external?: { min: number; sites?: string[] };
  notBroken?: string[]; // consumer sites never listed as broken
  allRead?: boolean; // every eligible file was read
  frameworks?: FrameworkExpected; // what a framework plugin must and must not produce (corpus/frameworks.ts)
};

export type Ratio = { hit: number; of: number };

export type CaseScore = {
  case: string; // the case folder, relative to the corpus root
  guards: string;
  knownFailure: string | null;
  precision: Ratio;
  recall: { certain: Ratio; likely: Ratio; exports: Ratio; removed: Ratio; moved: Ratio };
  validity: Ratio;
  gaps: Ratio;
  cuts: Ratio;
  controls: Ratio;
  failures: string[]; // one line per check that did not hold
  pass: boolean;
  ms: number;
};

export type CorpusTotals = Omit<CaseScore, "case" | "guards" | "knownFailure" | "failures" | "pass" | "ms"> & { cases: number; passed: number };

export type CorpusScore = {
  cases: CaseScore[];
  totals: CorpusTotals; // every case
  gate: { pass: boolean; failing: string[] }; // every case, known failures included
};

export function value(r: Ratio): number {
  return r.of === 0 ? 1 : r.hit / r.of;
}

const ratio = (): Ratio => ({ hit: 0, of: 0 });

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
}

// The repository of a case: the base committed, the change written over it
// and left uncommitted.
function buildRepo(dir: string): string {
  const root = mkdtempSync(join(tmpdir(), "oq-corpus-"));
  cpSync(join(dir, "base"), root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "corpus@example.com");
  git(root, "config", "user.name", "corpus");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  if (existsSync(join(dir, "change"))) cpSync(join(dir, "change"), root, { recursive: true, force: true });
  const del = join(dir, "delete.txt");
  if (existsSync(del)) {
    for (const line of readFileSync(del, "utf8").split("\n")) {
      const path = line.trim();
      if (path !== "") rmSync(join(root, path));
    }
  }
  return root;
}

const plain = (id: string): string => id.replace(/^base:/, "");

// Whether a symbol id is the symbol `spec` names.
export function matches(spec: string, id: string): boolean {
  const p = plain(id);
  const at = /^(.*#[^@]+)@(\d+)$/.exec(spec);
  if (at) return p.startsWith(`${at[1]}@${at[2]}:`);
  const i = p.lastIndexOf("@");
  return (i > p.indexOf("#") ? p.slice(0, i) : p) === spec;
}

type Site = { to: string; site: ImpactSite };

// The sites the answer states into `targets`: every edge into them the graph
// holds (what the packet carries), and every caller path the impact lists
// (a removed symbol's surviving callers come from there).
function answerSites(graph: Graph, impact: ImpactSummary, targets: Set<string>): Site[] {
  const seen = new Set<string>();
  const out: Site[] = [];
  const add = (to: string, site: ImpactSite) => {
    const k = `${to}\0${site.file}:${site.line}:${site.column}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ to, site });
  };
  for (const id of targets) for (const e of graph.in.get(id) ?? []) for (const s of e.sites) add(e.to, s);
  for (const p of impact.callers) for (const e of p.edges) if (targets.has(e.to)) for (const s of e.sites) add(e.to, s);
  return out;
}

const siteOf = (s: ImpactSite): string => `${s.file}:${s.line}`;

function evidenceOf(s: ImpactSite) {
  return { kind: s.evidence as EvidenceKind, tier: s.tier, via: s.via, note: s.note, rule: s.rule };
}

export function scoreAnswer(name: string, expected: Expected, graph: Graph, impact: ImpactSummary): Omit<CaseScore, "ms"> {
  const failures: string[] = [];
  const precision = ratio();
  const recall = { certain: ratio(), likely: ratio(), exports: ratio(), removed: ratio(), moved: ratio() };
  const validity = ratio();
  const gaps = ratio();
  const cuts = ratio();
  const controls = ratio();

  // ---------- the symbols the case is about ----------
  const allIds = [...graph.nodes.keys(), ...impact.symbols.map((s) => s.id)];
  const idsOf = (spec: string) => [...new Set(allIds.filter((id) => matches(spec, id)))];
  const targets = new Set<string>([...impact.touched, ...impact.removed]);
  for (const c of [...(expected.callers ?? []), ...(expected.notCertain ?? [])]) {
    const ids = idsOf(c.to);
    if (ids.length === 0) failures.push(`no symbol ${c.to} in the graph`);
    for (const id of ids) targets.add(id);
  }
  const sites = answerSites(graph, impact, targets);

  // ---------- certain precision ----------
  for (const s of sites) {
    if (s.site.tier !== "certain") continue;
    precision.of++;
    const ok = (expected.callers ?? []).some((c) => c.tier === "certain" && c.site === siteOf(s.site) && matches(c.to, s.to));
    if (ok) precision.hit++;
    else failures.push(`a certain site the case does not expect: ${siteOf(s.site)} to ${plain(s.to)} (${s.site.rule})`);
  }
  for (const n of expected.notCertain ?? []) {
    const bad = sites.find((s) => s.site.tier === "certain" && siteOf(s.site) === n.site && matches(n.to, s.to));
    if (bad) failures.push(`negative control broken: ${n.site} binds certain to ${plain(bad.to)} (${bad.site.rule})`);
  }

  // ---------- recall: callers by tier ----------
  for (const c of expected.callers ?? []) {
    const r = recall[c.tier];
    r.of++;
    const found = sites.filter((s) => siteOf(s.site) === c.site && matches(c.to, s.to));
    const atTier = found.find((s) => s.site.tier === c.tier);
    if (!atTier) {
      failures.push(found.length > 0 ? `${c.site} to ${c.to} is ${found.map((s) => s.site.tier).join(", ")}, expected ${c.tier}` : `caller not found: ${c.site} to ${c.to}`);
      continue;
    }
    if (c.note !== undefined && !(atTier.site.note ?? "").includes(c.note)) {
      failures.push(`${c.site} to ${c.to} has the note ${JSON.stringify(atTier.site.note)}, expected one naming ${JSON.stringify(c.note)}`);
      continue;
    }
    r.hit++;
  }

  // ---------- recall: the export diff ----------
  for (const x of expected.exports ?? []) {
    recall.exports.of += 1 + x.consumers.length;
    const got = impact.exports.find((e) => e.file === x.file && e.name === x.name && e.change === x.change);
    if (!got) {
      const other = impact.exports.find((e) => e.file === x.file && e.name === x.name);
      failures.push(other ? `export ${x.file} ${x.name} is ${other.change}, expected ${x.change}` : `export change not found: ${x.file} ${x.name} ${x.change}`);
      continue;
    }
    recall.exports.hit++;
    const listed = new Set(got.consumers.map((c) => `${c.file}:${c.line}:${c.now}`));
    for (const c of x.consumers) {
      if (listed.has(c)) recall.exports.hit++;
      else failures.push(`export ${x.file} ${x.name}: consumer ${c} not listed (listed: ${[...listed].join(", ") || "none"})`);
    }
  }

  // ---------- recall: removed and moved ----------
  const removedSymbols = impact.symbols.filter((s) => impact.removed.includes(s.id));
  for (const spec of expected.removed ?? []) {
    recall.removed.of++;
    const hit = removedSymbols.find((s) => matches(spec, s.id));
    if (!hit) failures.push(`removed symbol not found: ${spec}`);
    else if (hit.movedTo) failures.push(`${spec} reads as moved to ${hit.movedTo.file}:${hit.movedTo.line}, expected removed`);
    else recall.removed.hit++;
  }
  for (const m of expected.moved ?? []) {
    recall.moved.of++;
    const hit = removedSymbols.find((s) => matches(m.from, s.id));
    if (!hit) failures.push(`moved symbol not found among the removed: ${m.from}`);
    else if (!hit.movedTo) failures.push(`${m.from} reads as removed, expected moved to ${m.to}`);
    else if (!matches(m.to, hit.movedTo.id)) failures.push(`${m.from} moved to ${plain(hit.movedTo.id)}, expected ${m.to}`);
    else if ((hit.movedTo.renamed === true) !== m.renamed) failures.push(`${m.from} moved with renamed ${hit.movedTo.renamed === true}, expected ${m.renamed}`);
    else recall.moved.hit++;
  }

  // ---------- evidence validity ----------
  const checked = new Set<string>();
  const check = (where: string, s: ImpactSite) => {
    const k = `${where}\0${s.file}:${s.line}:${s.column}\0${s.rule}`;
    if (checked.has(k)) return;
    checked.add(k);
    validity.of++;
    const why = validateEvidence(evidenceOf(s));
    if (why === null) validity.hit++;
    else failures.push(`invalid evidence at ${siteOf(s)} (${where}, ${s.rule}): ${why}`);
  };
  for (const e of graph.edges) for (const s of e.sites) check(`${e.kind} ${plain(e.to)}`, s);
  for (const list of graph.importers.values()) for (const e of list) for (const s of e.sites) check(`imports ${e.to}`, s);
  for (const m of graph.misses) check(`miss ${m.target}#${m.name}`, m.site);

  // ---------- gap disclosure ----------
  for (const u of expected.unknowns ?? []) {
    gaps.of++;
    const near = impact.unknown.near.some((n) => n.file === u.file && n.line === u.line && n.cause === u.cause && (u.scope === undefined || n.scope === u.scope));
    const any = graph.unknowns.some((n) => n.file === u.file && n.line === u.line && n.cause === u.cause && (u.scope === undefined || n.scope === u.scope));
    if (near || any) gaps.hit++;
    else {
      const there = graph.unknowns.filter((n) => n.file === u.file && n.line === u.line).map((n) => `${n.cause}/${n.scope}`);
      failures.push(`unknown not disclosed: ${u.file}:${u.line} ${u.cause}${there.length > 0 ? ` (found ${there.join(", ")})` : ""}`);
    }
  }
  for (const [spec, want] of Object.entries(expected.floor ?? {})) {
    gaps.of++;
    const seeds = impact.unknown.seeds.filter((s) => matches(spec, s.seed));
    if (seeds.length === 0) failures.push(`${spec} is not a seed (neither touched nor removed), so it has no floor flag`);
    else if (seeds.every((s) => s.floor === want)) gaps.hit++;
    else failures.push(`${spec} floor is ${seeds.map((s) => s.floor).join(", ")}, expected ${want}${seeds[0]?.reasons.length ? ` (${seeds[0].reasons.join("; ")})` : ""}`);
  }

  // ---------- cut disclosure ----------
  for (const c of expected.cuts ?? []) {
    cuts.of++;
    if (impact.cuts.some((x) => x.by === c.by && x.omitted === c.omitted)) cuts.hit++;
    else {
      const same = impact.cuts.filter((x) => x.by === c.by).map((x) => String(x.omitted));
      failures.push(`cut not disclosed: ${c.by} with ${String(c.omitted)} omitted${same.length > 0 ? ` (found ${same.join(", ")})` : ""}`);
    }
  }

  // ---------- negative controls ----------
  for (const site of expected.notBroken ?? []) {
    controls.of++;
    const asConsumer = impact.exports.flatMap((e) => e.consumers.filter((c) => c.now === "broken" && `${c.file}:${c.line}` === site).map(() => `${e.file} ${e.name}`));
    const asCaller = removedSymbols.filter((s) => !s.movedTo && impact.callers.some((p) => p.edges.some((e) => e.to === s.id && e.sites.some((x) => siteOf(x) === site)))).map((s) => plain(s.id));
    if (asConsumer.length === 0 && asCaller.length === 0) controls.hit++;
    else failures.push(`${site} is listed as broken: ${[...asConsumer, ...asCaller.map((s) => `still calls removed ${s}`)].join("; ")}`);
  }
  if (expected.external) {
    controls.of++;
    const external = graph.status.externalSites;
    if (external >= expected.external.min) controls.hit++;
    else failures.push(`${external} external call sites, expected at least ${expected.external.min}`);
    for (const site of expected.external.sites ?? []) {
      controls.of++;
      const gap = graph.unknowns.find((u) => `${u.file}:${u.line}` === site);
      const edge = graph.edges.find((e) => e.kind === "calls" && e.sites.some((s) => siteOf(s) === site));
      const miss = graph.misses.find((m) => siteOf(m.site) === site);
      if (!gap && !edge && !miss) controls.hit++;
      else if (gap) failures.push(`${site} is an in-repo gap (${gap.cause}: ${gap.note ?? ""}), expected external`);
      else if (edge) failures.push(`${site} binds to ${plain(edge.to)}, expected external`);
      else failures.push(`${site} is a miss against ${miss?.target}, expected external`);
    }
  }
  if (expected.allRead) {
    controls.of++;
    if (graph.status.notRead.length === 0) controls.hit++;
    else failures.push(`files not read: ${graph.status.notRead.map((n) => `${n.file} (${n.reason})`).join(", ")}`);
  }

  // ---------- frameworks ----------
  // Expected registrations, edges, roles and brief lines count as recall at
  // their tier's place; validity, gaps and controls add to their own.
  const fw = scoreFrameworks(expected.frameworks, graph, impact, matches);
  recall.certain.of += fw.recall.of;
  recall.certain.hit += fw.recall.hit;
  validity.of += fw.validity.of;
  validity.hit += fw.validity.hit;
  gaps.of += fw.gaps.of;
  gaps.hit += fw.gaps.hit;
  controls.of += fw.controls.of;
  controls.hit += fw.controls.hit;
  failures.push(...fw.failures);

  const all = [precision, ...Object.values(recall), validity, gaps, cuts, controls];
  return {
    case: name,
    guards: expected.guards,
    knownFailure: expected.knownFailure ?? null,
    precision,
    recall,
    validity,
    gaps,
    cuts,
    controls,
    failures,
    pass: failures.length === 0 && all.every((r) => r.hit === r.of),
  };
}

export async function scoreCase(dir: string, name = dir): Promise<CaseScore> {
  const started = performance.now();
  let expected: Expected = { guards: name };
  let root: string | null = null;
  try {
    expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as Expected;
    if (!existsSync(join(dir, "README.md"))) throw new Error("the case has no README.md naming the failure it guards");
    root = buildRepo(dir);
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const graph = await buildGraph({
      repoRoot: root,
      store: null,
      files: change.changedPaths,
      base: { sha: change.baseSha, files: change.files },
      ...(expected.build?.maxFileBytes !== undefined ? { maxFileBytes: expected.build.maxFileBytes } : {}),
    });
    const impact = detectImpact(graph, change);
    return { ...scoreAnswer(name, expected, graph, impact), ms: Math.round(performance.now() - started) };
  } catch (error) {
    const empty = ratio();
    return {
      case: name,
      guards: expected.guards,
      knownFailure: expected.knownFailure ?? null,
      precision: empty,
      recall: { certain: empty, likely: empty, exports: empty, removed: empty, moved: empty },
      validity: empty,
      gaps: empty,
      cuts: empty,
      controls: empty,
      failures: [`the case did not run: ${(error as Error).stack ?? String(error)}`],
      pass: false,
      ms: Math.round(performance.now() - started),
    };
  } finally {
    if (root !== null) rmSync(root, { recursive: true, force: true });
  }
}

// Every folder under `root` that holds an expected.json or a base folder, in
// path order: a case missing either is scored as a failure, never skipped.
export function findCases(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (existsSync(join(dir, "expected.json")) || existsSync(join(dir, "base"))) {
      out.push(dir);
      return;
    }
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return out;
}

const add = (a: Ratio, b: Ratio): Ratio => ({ hit: a.hit + b.hit, of: a.of + b.of });

export function totalsOf(cases: CaseScore[]): CorpusTotals {
  const t: CorpusTotals = {
    cases: cases.length,
    passed: cases.filter((c) => c.pass).length,
    precision: ratio(),
    recall: { certain: ratio(), likely: ratio(), exports: ratio(), removed: ratio(), moved: ratio() },
    validity: ratio(),
    gaps: ratio(),
    cuts: ratio(),
    controls: ratio(),
  };
  for (const c of cases) {
    t.precision = add(t.precision, c.precision);
    for (const k of Object.keys(t.recall) as (keyof CaseScore["recall"])[]) t.recall[k] = add(t.recall[k], c.recall[k]);
    t.validity = add(t.validity, c.validity);
    t.gaps = add(t.gaps, c.gaps);
    t.cuts = add(t.cuts, c.cuts);
    t.controls = add(t.controls, c.controls);
  }
  return t;
}

export async function scoreCorpus(root: string): Promise<CorpusScore> {
  return scoreCases(root, findCases(root));
}

// The cases in `dirs`, named relative to `root`.
export async function scoreCases(root: string, dirs: readonly string[]): Promise<CorpusScore> {
  const cases: CaseScore[] = [];
  for (const dir of dirs) cases.push(await scoreCase(dir, relative(root, dir)));
  const failing = cases.filter((c) => !c.pass).map((c) => c.case);
  return { cases, totals: totalsOf(cases), gate: { pass: failing.length === 0, failing } };
}
