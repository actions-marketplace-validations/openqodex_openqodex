// The identical-score check of a scanner-only run (run.mjs
// --check-identical): two passes on one build, each scored, compared.
//
// Failure list, written before the code:
// 1. Two passes differ and nobody notices: the score of each pass and every
//    file every sample saved are compared. JSON and SARIF files (sample.json,
//    scan.json, report.json, report.sarif) are compared as canonical JSON
//    with the time fields left out; every other file (report.md,
//    receipt.txt, stderr.txt) as text with its documented time values left
//    out (TEXT_TIMES). One difference is enough, and each is named with its
//    file, and with its field for JSON.
// 2. A time field (a duration, a start time) makes two identical passes
//    differ: keys that hold a time are left out by name (TIME_KEY), and
//    nothing else is. The score's `run` (the folder it was read from) is
//    the only other field left out.
// 3. A change of the inputs between the passes (other Semgrep rule pack
//    bytes, other osv.dev advisories) reads as a product that is not
//    deterministic: when the two manifests' `external` records differ, the
//    cause is "input" and each input is named.
// 4. A sample, or a file of a sample, one pass has and the other lacks is
//    missed: every file under both passes' samples/ is listed, and a file
//    only one holds is a difference.
// 5. The registry serves one Semgrep rule set as JSON to one pass and as
//    YAML to the other, and the passes differ by the raw size of a pack:
//    each pack in a semgrep scanner entry's `rules` is compared by `pack`
//    and `sha256` (the hash of its rules), and its `bytes` is left out.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inputDifferences } from "./external.mjs";

// A key that holds a time: `at`, `*_at`, `*_ms`, `*Ms`, `*At`, `timings`
// and `elapsedMin`.
export const TIME_KEY = /(^|_)(at|ms)$|Ms$|At$|^timings$|^elapsedMin$/;

// The time values a saved text file carries, by the file's name: the Time
// column of report.md's scanner table (core render/markdown.ts writes each
// scanner's duration there as "<seconds to one decimal> s"). The scan's
// receipt.txt and stderr.txt carry none.
export const TEXT_TIMES = [{ file: /(^|\/)report\.md$/, pattern: /^(\| [^|\n]* \| [^|\n]* \| [^|\n]* \| \d+ \| \d+ \| )\d+(?:\.\d+)? s( \|)/gm, as: "$1<time>$2" }];

export function withoutTextTimes(file, text) {
  let out = text;
  for (const t of TEXT_TIMES) if (t.file.test(file)) out = out.replace(t.pattern, t.as);
  return out;
}

export function withoutTimes(v) {
  if (Array.isArray(v)) return v.map(withoutTimes);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !TIME_KEY.test(k)).map(([k, x]) => [k, withoutTimes(x)]));
  return v;
}

// A semgrep scanner entry (in scan.json and report.json) with each rule
// pack's raw size left out (failure 5).
function withoutPackSizes(v) {
  if (Array.isArray(v)) return v.map(withoutPackSizes);
  if (v && typeof v === "object") {
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutPackSizes(x)]));
    if (out.scanner === "semgrep" && Array.isArray(out.rules)) out.rules = out.rules.map((r) => (r && typeof r === "object" ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "bytes")) : r));
    return out;
  }
  return v;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// The first few fields where two values differ, as dotted paths.
function differingFields(a, b, at = "", out = [], limit = 5) {
  if (out.length >= limit) return out;
  const isObject = (x) => x !== null && typeof x === "object";
  if (isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (canonical(a[k]) !== canonical(b[k])) differingFields(a[k], b[k], at === "" ? k : `${at}.${k}`, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  out.push(at === "" ? "(the whole value)" : at);
  return out;
}

// Every file under a pass's samples/, by its path in the pass.
function sampleFiles(folder) {
  const root = join(folder, "samples");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(folder, join(e.parentPath, e.name)).split("\\").join("/"));
}

const STRUCTURED = /\.(json|sarif)$/;

// What one saved file differs in between the two passes, or null when it
// does not: its fields for JSON and SARIF, its first differing line for text.
function fileDifference(file, a, b) {
  if (STRUCTURED.test(file)) {
    const x = withoutPackSizes(withoutTimes(readJson(join(a, file))));
    const y = withoutPackSizes(withoutTimes(readJson(join(b, file))));
    return canonical(x) === canonical(y) ? null : differingFields(x, y).join(", ");
  }
  const x = withoutTextTimes(file, readFileSync(join(a, file), "utf8")).split("\n");
  const y = withoutTextTimes(file, readFileSync(join(b, file), "utf8")).split("\n");
  const at = x.findIndex((line, i) => line !== y[i]);
  if (at === -1 && x.length === y.length) return null;
  return `line ${(at === -1 ? Math.min(x.length, y.length) : at) + 1}`;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Compares two scored passes by their folders (each with manifest.json,
// score.json and samples/). `cause` is null when they are identical,
// "input" when their external inputs differ, else "product".
export function comparePasses(a, b) {
  const differences = [];
  // The score's `run` names the folder it was read from, which differs by design.
  const score = (folder) => {
    const s = readJson(join(folder, "score.json"));
    delete s.run;
    return withoutTimes(s);
  };
  const sa = score(a);
  const sb = score(b);
  if (canonical(sa) !== canonical(sb)) differences.push(`score.json: ${differingFields(sa, sb).join(", ")}`);
  for (const file of [...new Set([...sampleFiles(a), ...sampleFiles(b)])].sort()) {
    if (!existsSync(join(a, file)) || !existsSync(join(b, file))) {
      differences.push(`${file}: only one pass holds it`);
      continue;
    }
    const differs = fileDifference(file, a, b);
    if (differs !== null) differences.push(`${file}: ${differs}`);
  }
  const inputs = inputDifferences(readJson(join(a, "manifest.json")).external ?? null, readJson(join(b, "manifest.json")).external ?? null);
  const identical = differences.length === 0;
  return { identical, cause: identical ? null : inputs.length > 0 ? "input" : "product", inputs, differences };
}
