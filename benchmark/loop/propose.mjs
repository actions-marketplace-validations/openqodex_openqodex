#!/usr/bin/env node
// The only door into the reviewer loop. A change is one branch from its
// parent, one lever's files, and a record written before any run: what it
// expects (hypothesis), the one metric it must move (primary) and how much
// every guard may lose (acceptableLoss). propose checks the branch and the
// record and appends one `event: "proposed"` line to the reviewer ledger,
// benchmark/index/ledger/reviewer.jsonl (PLAN-benchmark 4.8). loop.mjs
// propose (P3-05) calls the same function.
//
//   node benchmark/loop/propose.mjs --template <lever>      a record with the lever's defaults
//   node benchmark/loop/propose.mjs <record.json> [--repo <dir>] [--ledger <file>]
//
// Exit codes: 0 the line is written, 1 refused (every reason printed),
// 2 the check itself failed (git, a corrupt ledger, a suite's truth unread).
//
// Failure list, written before the code:
// 1. A record enters without a hypothesis, a primary metric or a loss for
//    every guard, so the bar is chosen after the score is seen: each is
//    required, and a loss must be a number of 0 or more.
// 2. A record is changed after it exists (a wider loss, another primary),
//    or a second record is written for the same branch or commit: any
//    proposed line for that branch or commit refuses the new one, and the
//    ledger is only ever appended to.
// 3. A change reaches files of another lever, or the loop's truth, or names
//    a case, or keys a variant on a model: the lever's globs and the leak
//    check (leak-check.mjs) refuse it.
// 4. A change runs on fewer paths than its files reach: the record's paths
//    are worked out from the changed files, never typed in.
// 5. Two writers number a line the same or a half-written ledger is read as
//    sound: ids are one past the highest in the ledger, every line must
//    parse with v 1, and a ledger not ending in a newline stops the write.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { repoRoot } from "../lib/cases.mjs";
import { ledgerPath } from "../lib/index.mjs";
import { ToolError, git, leakRefusals, revParse } from "./leak-check.mjs";

export const LEVERS_PATH = fileURLToPath(new URL("./levers.json", import.meta.url));
export const LEDGER = ledgerPath("reviewer");
export const PATHS = ["laptop", "server"];
export const AIMS = ["quality", "simplify", "measure"];

// A glob over repository paths: ** crosses folders, * and ? do not.
export function globRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// The registry, checked so a broken entry stops the door rather than
// letting a change through.
export function loadLevers(path = LEVERS_PATH) {
  const reg = JSON.parse(readFileSync(path, "utf8"));
  const p = [];
  if (reg.version !== 1) p.push("version must be 1");
  for (const [m, d] of Object.entries(reg.metrics ?? {})) {
    if (d.better !== "higher" && d.better !== "lower") p.push(`metric ${m}: better must be higher or lower`);
    if (!Number.isFinite(d.loss) || d.loss < 0) p.push(`metric ${m}: loss must be a number of 0 or more`);
  }
  const fileEntry = (where, f) => {
    if (typeof f?.glob !== "string" || f.glob === "") p.push(`${where}: a file entry needs a glob`);
    if (!Array.isArray(f?.paths) || !f.paths.every((x) => PATHS.includes(x))) p.push(`${where} ${f?.glob}: paths must be a list of ${PATHS.join(" and ")}`);
  };
  for (const f of reg.companions ?? []) fileEntry("companions", f);
  const ids = new Set();
  for (const lever of reg.levers ?? []) {
    if (ids.has(lever.id)) p.push(`lever ${lever.id} is listed twice`);
    ids.add(lever.id);
    if (!Array.isArray(lever.files) || lever.files.length === 0) p.push(`lever ${lever.id}: files must list at least one glob`);
    for (const f of lever.files ?? []) fileEntry(`lever ${lever.id}`, f);
    if (!Object.hasOwn(reg.metrics ?? {}, lever.primary)) p.push(`lever ${lever.id}: primary ${lever.primary} is not a metric`);
  }
  if (!Array.isArray(reg.modelNames) || reg.modelNames.length === 0) p.push("modelNames must list the model and provider names");
  if (!AIMS.includes(reg.defaults?.aim) || !PATHS.includes(reg.defaults?.target)) p.push("defaults need an aim and a target path");
  if (p.length > 0) throw new ToolError(`${path} is not sound:\n${p.join("\n")}`);
  return reg;
}

// A record with the lever's defaults, for a person to fill in.
export function template(reg, leverId) {
  const lever = reg.levers.find((l) => l.id === leverId);
  if (!lever) return null;
  return {
    lever: lever.id,
    title: "",
    hypothesis: "",
    branch: "",
    parent: "",
    aim: reg.defaults.aim,
    target: reg.defaults.target,
    primary: { metric: lever.primary },
    acceptableLoss: Object.fromEntries(Object.entries(reg.metrics).map(([m, d]) => [m, d.loss])),
    capUsd: reg.defaults.capUsd,
    capReviews: reg.defaults.capReviews,
    proposedBy: "",
  };
}

const text = (v) => typeof v === "string" && v.trim() !== "";

// What is wrong with a record on its own, before the branch is read.
export function recordProblems(record, reg) {
  const p = [];
  const lever = reg.levers.find((l) => l.id === record?.lever);
  if (!lever) p.push(`the record names no known lever (${record?.lever ?? "none"}); levers: ${reg.levers.map((l) => l.id).join(", ")}`);
  for (const field of ["title", "branch", "parent", "proposedBy"]) if (!text(record?.[field])) p.push(`the record has no ${field}`);
  if (!text(record?.hypothesis)) p.push("the record has no hypothesis");
  const metric = record?.primary?.metric;
  if (!text(metric)) p.push("the record names no primary metric");
  else if (!Object.hasOwn(reg.metrics, metric)) p.push(`the primary metric ${metric} is not one of ${Object.keys(reg.metrics).join(", ")}`);
  else if (record.primary.better !== undefined && record.primary.better !== reg.metrics[metric].better) p.push(`the primary metric ${metric} is better ${reg.metrics[metric].better}, not ${record.primary.better}`);
  const losses = record?.acceptableLoss;
  if (losses === null || typeof losses !== "object" || Array.isArray(losses)) p.push("the record has no acceptable loss for any guard");
  else {
    for (const m of Object.keys(reg.metrics)) {
      if (!Object.hasOwn(losses, m)) p.push(`the record has no acceptable loss for ${m}`);
      else if (!Number.isFinite(losses[m]) || losses[m] < 0) p.push(`the acceptable loss for ${m} must be a number of 0 or more`);
    }
    for (const m of Object.keys(losses)) if (!Object.hasOwn(reg.metrics, m)) p.push(`the acceptable loss names ${m}, which is not a guard`);
  }
  if (record?.aim !== undefined && !AIMS.includes(record.aim)) p.push(`aim must be one of ${AIMS.join(", ")}`);
  if (record?.target !== undefined && !PATHS.includes(record.target)) p.push(`target must be one of ${PATHS.join(", ")}`);
  for (const cap of ["capUsd", "capReviews"]) if (record?.[cap] !== undefined && !(Number.isFinite(record[cap]) && record[cap] > 0)) p.push(`${cap} must be a number above 0`);
  return p;
}

// Every line of the ledger, parsed; a line that does not parse, or a file
// cut mid-line, stops the write.
export function readLedger(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw !== "" && !raw.endsWith("\n")) throw new ToolError(`${path} does not end with a newline; a line was cut, so nothing is appended until a person mends it`);
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l, i) => {
      let line;
      try {
        line = JSON.parse(l);
      } catch {
        throw new ToolError(`${path} line ${i + 1} is not JSON`);
      }
      if (line?.v !== 1 || typeof line.id !== "string") throw new ToolError(`${path} line ${i + 1} has no v 1 and id`);
      return line;
    });
}

const nextId = (lines) => `RC-${String(lines.reduce((n, l) => Math.max(n, Number(/^RC-(\d+)$/.exec(l.id)?.[1] ?? 0)), 0) + 1).padStart(4, "0")}`;

// The file entry a changed path falls under: the lever's own first, then
// the companions. null when it is outside both.
const entryFor = (path, lever, reg) => [...lever.files, ...reg.companions].find((f) => globRegex(f.glob).test(path)) ?? null;

// Checks a record and its branch and, when nothing is refused, appends the
// proposed line. Returns { refusals, line }.
export function propose(record, { repo = repoRoot, ledger = LEDGER, reg = loadLevers(), env = process.env, now = new Date() } = {}) {
  const refusals = recordProblems(record, reg);
  const lines = readLedger(ledger);
  const lever = reg.levers.find((l) => l.id === record?.lever);
  const top = git(repo, ["rev-parse", "--show-toplevel"]).out.trim();
  const commit = text(record?.branch) ? revParse(top, `refs/heads/${record.branch}`) : null;
  const parent = text(record?.parent) ? revParse(top, record.parent) : null;
  if (text(record?.branch) && !commit) refusals.push(`branch ${record.branch} is not in ${top}`);
  if (text(record?.parent) && !parent) refusals.push(`parent ${record.parent} is not a commit in ${top}`);

  const before = lines.find((l) => l.event === "proposed" && (l.record?.branch === record?.branch || (commit && l.record?.commit === commit)));
  if (before) {
    const edited = !isDeepStrictEqual(before.record.primary?.metric, record?.primary?.metric) || !isDeepStrictEqual(before.record.acceptableLoss, record?.acceptableLoss);
    refusals.push(
      edited
        ? `the record of ${before.id} (branch ${before.record.branch}, commit ${String(before.record.commit ?? "").slice(0, 8)}) already exists; its primary metric and acceptable losses cannot be edited after the record exists, so a new bar is a new branch`
        : `${before.id} already holds the record of branch ${before.record.branch} at commit ${String(before.record.commit ?? "").slice(0, 8)}; it stands as written`,
    );
  }

  let paths = [];
  if (commit && parent && lever) {
    if (git(top, ["merge-base", "--is-ancestor", parent, commit], { ok: [0, 1] }).status !== 0) refusals.push(`branch ${record.branch} does not start from its parent ${parent.slice(0, 8)}`);
    else {
      const leak = leakRefusals(top, parent, commit, { modelNames: reg.modelNames, env });
      if (leak.changed.length === 0) refusals.push(`branch ${record.branch} changes nothing against its parent`);
      const reached = new Set();
      for (const { path } of leak.changed) {
        const entry = entryFor(path, lever, reg);
        if (entry) for (const x of entry.paths) reached.add(x);
        else if (!leak.refusals.some((r) => r.startsWith(`${path}: `))) refusals.push(`${path} is outside lever ${lever.id} (its files: ${lever.files.map((f) => f.glob).join(", ")})`);
      }
      refusals.push(...leak.refusals);
      paths = PATHS.filter((x) => reached.has(x));
      const target = record.target ?? reg.defaults.target;
      if (leak.changed.length > 0 && !paths.includes(target)) refusals.push(`target ${target} is not a path this change runs on (${paths.length > 0 ? paths.join(" and ") : "none: only tests and changesets changed"})`);
    }
  }
  if (refusals.length > 0) return { refusals, line: null };

  const line = {
    v: 1,
    id: nextId(lines),
    at: now.toISOString(),
    event: "proposed",
    record: {
      lever: lever.id,
      title: record.title.trim(),
      hypothesis: record.hypothesis.trim(),
      branch: record.branch,
      parent,
      commit,
      paths,
      target: record.target ?? reg.defaults.target,
      aim: record.aim ?? reg.defaults.aim,
      primary: { metric: record.primary.metric, better: reg.metrics[record.primary.metric].better },
      acceptableLoss: Object.fromEntries(Object.keys(reg.metrics).map((m) => [m, record.acceptableLoss[m]])),
      capUsd: record.capUsd ?? reg.defaults.capUsd,
      capReviews: record.capReviews ?? reg.defaults.capReviews,
      proposedBy: record.proposedBy.trim(),
    },
    runs: [],
    look: null,
    alpha: null,
    results: {},
    strata: null,
    causes: {},
    stage: null,
    decision: null,
    reason: null,
    spendUsd: 0,
    laptopReviews: 0,
    minutes: 0,
    pr: null,
  };
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify(line)}\n`);
  return { refusals: [], line };
}

function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ToolError(`${name} needs a value`);
    argv.splice(i, 2);
    return value;
  };
  const reg = loadLevers();
  const leverId = flag("--template");
  if (leverId !== undefined) {
    const t = template(reg, leverId);
    if (!t) throw new ToolError(`no lever ${leverId}; levers: ${reg.levers.map((l) => l.id).join(", ")}`);
    process.stdout.write(`${JSON.stringify(t, null, 2)}\n`);
    return 0;
  }
  const repo = resolve(flag("--repo") ?? repoRoot);
  const ledger = resolve(flag("--ledger") ?? LEDGER);
  if (argv.length !== 1) throw new ToolError("usage: node benchmark/loop/propose.mjs <record.json> [--repo <dir>] [--ledger <file>], or --template <lever>");
  let record;
  try {
    record = JSON.parse(readFileSync(argv[0], "utf8"));
  } catch (error) {
    throw new ToolError(`the record ${argv[0]} cannot be read as JSON (${error.message})`);
  }
  const { refusals, line } = propose(record, { repo, ledger, reg });
  if (refusals.length > 0) {
    process.stdout.write(`refused, nothing written:\n${refusals.map((r) => `- ${r}`).join("\n")}\n`);
    return 1;
  }
  const r = line.record;
  process.stdout.write(`${line.id} proposed: lever ${r.lever}, branch ${r.branch} at ${r.commit.slice(0, 8)} from ${r.parent.slice(0, 8)}, runs on ${r.paths.join(" and ")}, target ${r.target}, primary ${r.primary.metric}; written to ${ledger}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof ToolError ? "" : "propose failed: "}${error.message}\n`);
    process.exitCode = 2;
  }
}
