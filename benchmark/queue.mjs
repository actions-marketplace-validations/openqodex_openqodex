#!/usr/bin/env node
// The review queue: findings that no frozen spec decides, waiting for a
// person to rule on them.
//
//   node benchmark/queue.mjs add <run folder | unresolved file> [--queue <folder>]
//   node benchmark/queue.mjs sheet <suite> [--seed <n>] [--json] [--queue <folder>]
//   node benchmark/queue.mjs decide <status> <target>... --by <your name>
//        [--bug <truth id>] [--note <text>] [--sheet <sheet id>] [--queue <folder>]
//
// add merges a scored run's unresolved.jsonl (score.mjs writes it) into
// <queue>/<suite>.jsonl, one item per finding, and drops every question the
// rulings already answer. sheet prints the open items blind: the case, the
// finding, the code and the truth item, in a seeded shuffle, with no run,
// build, configuration or count. decide appends one ruling to
// <queue>/decisions.jsonl, the adjudication file (lib/rulings.mjs), which
// score.mjs reads. The queue folder is benchmark/review-queue unless
// --queue names another.
//
// decide's statuses and targets:
//   true | false <ref>                         the finding is a real issue the truth does not list, or not
//   true | false <case id>#I<n>                the same for an issue a person consolidated
//     (spec-candidate-accepted and spec-candidate-rejected are true and false)
//   same-issue | different-issue <ref>         the finding is, or is not, the truth item it sits on
//   consolidate <ref> <ref>...                 these findings of one case are one issue in different words
//   confirmed | disputed <case id> --bug <id>  a truth item of the case is right, or wrong
//   clean | not-clean <case id>                a candidate clean control has no issue, or has one
// <ref> is the start of a findingId, 8 hex or more, as the sheet prints it.
// --by names the person who made the ruling, as people.json in the queue
// folder lists them. A model or an agent never rules: the session may draft
// rulings, and a person records them.
//
// Exit codes: 0 done; 2 refused, with nothing written.
//
// Failure list, written before the code (the queue's own is in lib/queue.mjs):
// 1. A ruling is written without a person's name, or under a model's or an
//    agent's: decide refuses before it writes anything.
// 2. A ref that matches two findings puts the ruling on the wrong one: a ref
//    must match exactly one known finding.
// 3. A consolidate line groups findings of two cases, or a single finding:
//    refused.
// 4. A ruling on an issue no person consolidated: refused.
// 5. A same-issue ruling names a truth item the finding does not sit on:
//    the truth item is always the one the queue item names.
// 6. The blind sheet shows the run, the build, the configuration, the arm or
//    how often a finding recurred, or its order cannot be drawn again: it
//    carries the case, the finding, the code and the truth item only, every
//    text through the shared redactor (lib/drops.mjs) fed with every run,
//    build (its full commit and its short form) and configuration the items
//    were seen in, in a seeded shuffle (lib/drops.mjs drawAudit) whose seed
//    it prints.
// 7. A held-out run's findings enter the committed queue: add refuses items
//    from a test split.
// 8. A crash halfway through add leaves half a queue: the new file is
//    written beside the old and renamed over it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot } from "./lib/cases.mjs";
import { drawAudit, redactor } from "./lib/drops.mjs";
import { mergeQueue, openAsks } from "./lib/queue.mjs";
import { REAL, STATUSES, isPersonName, issueOf, readDecisions, resolveRulings, rulingProblems } from "./lib/rulings.mjs";

export const queueRoot = join(benchRoot, "review-queue");
const DECISIONS = "decisions.jsonl";

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
function writeJsonl(path, items) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, items.map((i) => `${JSON.stringify(i)}\n`).join(""));
  renameSync(temp, path);
}

// The unresolved file to add: the path itself, or in a run folder its
// unresolved.jsonl, or its one unresolved-<specs>.jsonl.
function unresolvedFile(path) {
  if (statSync(path).isFile()) return path;
  const names = readdirSync(path).filter((n) => /^unresolved(-.+)?\.jsonl$/.test(n)).sort();
  if (names.includes("unresolved.jsonl")) return join(path, "unresolved.jsonl");
  if (names.length === 1) return join(path, names[0]);
  if (names.length === 0) throw new Error(`${path} holds no unresolved.jsonl; score the run first: node benchmark/score.mjs ${path}`);
  throw new Error(`${path} holds ${names.join(", ")}; name the one to add`);
}

export function add(path, { queue = queueRoot } = {}) {
  const file = unresolvedFile(resolve(path));
  const items = readJsonl(file);
  const heldOut = items.filter((i) => i.split === "test");
  if (heldOut.length > 0) throw new Error(`refused: ${file} holds ${heldOut.length} findings of a held-out (test split) run, whose per-case detail stays in the run's asset`);
  const d = readDecisions(join(queue, DECISIONS));
  const R = resolveRulings(d.lines, d.people);
  mkdirSync(queue, { recursive: true });
  const out = [];
  for (const suite of [...new Set(items.map((i) => i.suite))].sort()) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(suite))) throw new Error(`refused: an item names the suite ${JSON.stringify(suite)}`);
    const target = join(queue, `${suite}.jsonl`);
    const before = readJsonl(target);
    const merged = mergeQueue(before, items.filter((i) => i.suite === suite), R);
    writeJsonl(target, merged);
    const had = new Set(before.map((i) => i.findingId));
    out.push(`${suite}: ${items.filter((i) => i.suite === suite).length} findings from ${file}; ${merged.filter((i) => !had.has(i.findingId)).length} new, ${merged.length} awaiting a ruling in ${target}`);
  }
  return out;
}

// The questions as the sheet asks them.
export const QUESTIONS = {
  match: "Is this finding the same issue as the truth item it sits on? Rule same-issue or different-issue.",
  real: "Is it a real issue in this change, one the case does not list? Rule true or false.",
};

// The blind sheet of the open items (lib/queue.mjs openAsks): { sheet,
// suite, seed, items }, each item with the case, the finding, the code and
// the truth item only.
export function blindSheet(items, { suite, seed }) {
  const known = [];
  for (const i of items) {
    for (const o of i.occurrences ?? []) {
      known.push({ kind: "run", value: o.run }, { kind: "configuration", value: o.config });
      // The full commit and its short form: either alone names the build.
      for (const value of [o.commit, o.build]) if (value) known.push({ kind: "build", value });
    }
  }
  const redact = redactor(known);
  const r = (s) => (s === null || s === undefined ? s : redact(s));
  return {
    sheet: `${suite}@${seed}`,
    suite,
    seed,
    items: drawAudit(items, items.length, seed).map((i, n) => ({
      item: n + 1,
      ref: i.findingId.slice(0, 12),
      issueId: i.issueId ?? null,
      caseId: i.caseId,
      file: r(i.file),
      lines: i.lines,
      category: i.category,
      severity: i.severity,
      text: { title: r(i.text.title), problem: r(i.text.problem), consequence: r(i.text.consequence), fix: r(i.text.fix) },
      evidence: { lines: i.evidence.lines, text: r(i.evidence.text), context: r(i.evidence.context), sha256: i.evidence.sha256, missing: i.evidence.missing ?? [] },
      truth: i.truth ? { id: r(i.truth.id), file: r(i.truth.file), lines: i.truth.lines, text: r(i.truth.text) } : null,
      // Whether it is the truth item first: a same-issue ruling answers both.
      asks: ["match", "real"].filter((a) => i.asks.includes(a)).map((a) => QUESTIONS[a]),
    })),
  };
}

const span = (lines) => (lines[1] > lines[0] ? `lines ${lines[0]} to ${lines[1]}` : `line ${lines[0]}`);
function fenced(text, lang = "") {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${lang}`, text, fence];
}

// The sheet as a person reads it.
export function sheetMarkdown(s) {
  const out = [
    `# Review queue: ${s.suite}`,
    "",
    `Sheet ${s.sheet}: ${s.items.length} findings in a shuffled order (seed ${s.seed}). For each, read the case, the finding, the code and, when there is one, the truth item it sits on. Then record your ruling under your own name:`,
    "",
    "```",
    `node benchmark/queue.mjs decide same-issue|different-issue <ref> --by <your name> --sheet ${s.sheet}`,
    `node benchmark/queue.mjs decide true|false <ref> --by <your name> --sheet ${s.sheet}`,
    `node benchmark/queue.mjs decide consolidate <ref> <ref>... --by <your name> --sheet ${s.sheet}`,
    "```",
    "",
    "Consolidate findings of one case only when they are the same issue in other words. Sharing a line is not enough.",
    "",
  ];
  for (const x of s.items) {
    out.push(`## ${x.item}. ${x.ref}`, "", `- Case: ${x.caseId}`, `- Place: ${x.file}, ${span(x.lines)}`, `- Kind: ${x.category}, rated ${x.severity}`, `- Title: ${x.text.title}`, `- Problem: ${x.text.problem}`, `- Consequence: ${x.text.consequence}`, `- Fix: ${x.text.fix}`, "");
    if (x.evidence.text !== null) {
      out.push("The code at those lines:", "", ...fenced(x.evidence.text), "");
      if (x.evidence.missing.length > 0) out.push(`The diff did not show line ${x.evidence.missing.join(", ")}.`, "");
      out.push("The change around them:", "", ...fenced(x.evidence.context, "diff"), "");
    } else if (x.evidence.sha256 !== null) out.push(`The code is not shown here: the case's licence does not allow it. Its sha256 is ${x.evidence.sha256}; open the case to read it.`, "");
    else out.push("The diff the reviewer was given does not show those lines; open the case to read them.", "");
    if (x.truth) out.push(`The truth item it sits on: ${x.truth.id}, ${x.truth.file} ${span(x.truth.lines)}. ${x.truth.text}`, "");
    if (x.issueId) out.push(`A person consolidated it into ${x.issueId}: rule the whole issue with decide true|false ${x.issueId}.`, "");
    for (const q of x.asks) out.push(`- ${q}`);
    out.push("- Ruling: ", "");
  }
  return out.join("\n");
}

export function sheet(suite, { seed, queue = queueRoot } = {}) {
  const d = readDecisions(join(queue, DECISIONS));
  const R = resolveRulings(d.lines, d.people);
  const open = [];
  for (const item of readJsonl(join(queue, `${suite}.jsonl`))) {
    const asks = openAsks(item, R);
    if (asks.length > 0) open.push({ ...item, issueId: issueOf(item.findingId, R), asks, truth: asks.includes("match") ? item.truth : null });
  }
  return blindSheet(open, { suite, seed });
}

// Every finding decide can name: the queue's items, and the findings the
// adjudication file already names (a ruled finding leaves the queue but can
// still be consolidated).
function knownFindings(queue, lines) {
  const known = new Map();
  const files = existsSync(queue) ? readdirSync(queue).filter((n) => n.endsWith(".jsonl") && n !== DECISIONS) : [];
  for (const name of files.sort()) for (const i of readJsonl(join(queue, name))) known.set(i.findingId, { caseId: i.caseId, evidence: i.evidence, truth: i.truth, specsFrom: i.specsFrom ?? null });
  for (const l of lines) {
    if (!l || typeof l !== "object" || !l.target) continue;
    const ids = [l.target.findingId, ...(Array.isArray(l.target.members) ? l.target.members : [])].filter((x) => typeof x === "string");
    for (const id of ids) if (!known.has(id)) known.set(id, { caseId: l.caseId, evidence: l.target.findingId === id ? (l.evidence ?? null) : null, truth: null, specsFrom: l.specsFrom ?? null });
  }
  return known;
}

function findingOf(ref, known) {
  if (!/^[0-9a-f]{8,64}$/.test(ref)) throw new Error(`refused: ${ref} is not a finding ref (8 or more hex of a findingId)`);
  const hits = [...known.keys()].filter((id) => id.startsWith(ref));
  if (hits.length !== 1) throw new Error(`refused: ${ref} matches ${hits.length === 0 ? "no finding in the queue or the adjudication file" : `${hits.length} findings; give more of it`}`);
  return { findingId: hits[0], ...known.get(hits[0]) };
}

const evidenceOf = (f) => (f.evidence ? { text: f.evidence.text ?? null, lines: f.evidence.lines, sha256: f.evidence.sha256 ?? null } : null);

// The ruling line for one decide call, checked; throws when it is refused.
export function rulingLine(status, targets, { by, bug = null, note = "", sheet: fromSheet = null, queue = queueRoot, now = new Date() } = {}) {
  const { lines, people } = readDecisions(join(queue, DECISIONS));
  if (!isPersonName(by, people)) throw new Error(`refused: --by must name the person who made this ruling, as ${join(queue, "people.json")} lists them, not ${JSON.stringify(by ?? null)}. A model or an agent never rules; the session may draft rulings, and a person records them.`);
  const kinds = Object.entries(STATUSES).filter(([, s]) => s.includes(status)).map(([k]) => k);
  if (kinds.length === 0) throw new Error(`refused: ${status} is not a status; use one of ${[...new Set(Object.values(STATUSES).flat())].join(", ")}`);
  const R = resolveRulings(lines, people);
  const known = knownFindings(queue, lines);
  const one = () => {
    if (targets.length !== 1) throw new Error(`refused: ${status} takes one target, not ${targets.length}`);
    return targets[0];
  };
  let caseId;
  let target;
  let found = null;
  if (status === "confirmed" || status === "disputed") {
    caseId = one();
    if (!bug) throw new Error(`refused: ${status} names the truth item with --bug <id>`);
    target = { kind: "bug", id: bug };
  } else if (status === "clean" || status === "not-clean") {
    caseId = one();
    target = { kind: "case" };
  } else if (status === "consolidate") {
    const members = targets.map((t) => findingOf(t, known));
    const ids = [...new Set(members.map((m) => m.findingId))].sort();
    if (ids.length < 2) throw new Error("refused: consolidate names two or more different findings");
    const cases = [...new Set(members.map((m) => m.caseId))];
    if (cases.length !== 1) throw new Error(`refused: the findings belong to ${cases.length} cases (${cases.join(", ")}); an issue is of one case`);
    caseId = cases[0];
    const prefix = `${caseId}#I`;
    const used = lines.filter((l) => typeof l?.target?.issueId === "string" && l.target.issueId.startsWith(prefix)).map((l) => Number(l.target.issueId.slice(prefix.length))).filter(Number.isInteger);
    target = { kind: "issue", issueId: `${prefix}${Math.max(0, ...used) + 1}`, members: ids };
  } else if (REAL[status] && /#I\d+$/.test(one())) {
    const issueId = one();
    if (!R.grouped.has(issueId)) throw new Error(`refused: no person consolidated ${issueId}; consolidate its findings first`);
    caseId = issueId.slice(0, issueId.lastIndexOf("#I"));
    target = { kind: "issue", issueId, members: [...R.members].filter(([, i]) => i === issueId).map(([f]) => f).sort() };
  } else if (REAL[status]) {
    found = findingOf(one(), known);
    caseId = found.caseId;
    target = { kind: "finding", findingId: found.findingId };
  } else {
    found = findingOf(one(), known);
    if (!found.truth) throw new Error(`refused: the queue names no truth item this finding sits on, so there is nothing to rule ${status} against`);
    caseId = found.caseId;
    target = { kind: "match", findingId: found.findingId, truthId: found.truth.id };
  }
  const line = { v: 1, caseId, ...(found?.specsFrom ? { specsFrom: found.specsFrom } : {}), fromSheet, target, status, by: by.trim(), at: now.toISOString(), note, evidence: found ? evidenceOf(found) : null };
  const problems = rulingProblems(line, people);
  if (problems.length > 0) throw new Error(`refused: ${problems.join("; ")}`);
  return line;
}

export function decide(status, targets, opts = {}) {
  const queue = opts.queue ?? queueRoot;
  const line = rulingLine(status, targets, { ...opts, queue });
  mkdirSync(queue, { recursive: true });
  appendFileSync(join(queue, DECISIONS), `${JSON.stringify(line)}\n`);
  const what = line.target.kind === "finding" || line.target.kind === "match" ? `finding ${line.target.findingId.slice(0, 12)}` : line.target.kind === "issue" ? line.target.issueId : line.target.kind === "bug" ? `${line.caseId} truth item ${line.target.id}` : line.caseId;
  return `Recorded ${status} on ${what}${line.target.kind === "match" ? ` against ${line.target.truthId}` : ""}, by ${line.by}, in ${join(queue, DECISIONS)}`;
}

const USAGE = `usage:
  node benchmark/queue.mjs add <run folder | unresolved file> [--queue <folder>]
  node benchmark/queue.mjs sheet <suite> [--seed <n>] [--json] [--queue <folder>]
  node benchmark/queue.mjs decide <status> <target>... --by <your name> [--bug <id>] [--note <text>] [--sheet <id>] [--queue <folder>]`;

function main() {
  const args = process.argv.slice(2);
  const opts = { json: false };
  const pos = [];
  const valued = { "--queue": "queue", "--seed": "seed", "--by": "by", "--bug": "bug", "--note": "note", "--sheet": "sheet" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") opts.json = true;
    else if (valued[args[i]]) {
      if (i + 1 >= args.length) {
        console.error(`${args[i]} needs a value\n${USAGE}`);
        process.exit(2);
      }
      opts[valued[args[i]]] = args[++i];
    } else if (args[i].startsWith("--")) {
      console.error(`unknown flag ${args[i]}\n${USAGE}`);
      process.exit(2);
    } else pos.push(args[i]);
  }
  const queue = opts.queue ? resolve(opts.queue) : queueRoot;
  const [command, ...rest] = pos;
  try {
    if (command === "add" && rest.length === 1) for (const l of add(rest[0], { queue })) console.log(l);
    else if (command === "sheet" && rest.length === 1) {
      const seed = opts.seed === undefined ? Math.floor(Date.now() / 1000) % 2147483647 : Number(opts.seed);
      if (!Number.isInteger(seed) || seed < 0) throw new Error(`refused: --seed must be a whole number, not ${opts.seed}`);
      const s = sheet(rest[0], { seed, queue });
      console.log(opts.json ? JSON.stringify(s, null, 2) : sheetMarkdown(s));
    } else if (command === "decide" && rest.length >= 2) console.log(decide(rest[0], rest.slice(1), { by: opts.by, bug: opts.bug, note: opts.note ?? "", sheet: opts.sheet ?? null, queue }));
    else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

// Run as a script, not imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
