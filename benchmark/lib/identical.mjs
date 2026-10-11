// The identical-score check of a scanner-only run (run.mjs
// --check-identical): two passes on one build, each scored, compared.
//
// Failure list, written before the code:
// 1. Two passes differ and nobody notices: the score of each pass and every
//    JSON file of every sample (sample.json, scan.json, report.json) are
//    compared as canonical JSON, with only the time fields left out; one
//    difference is enough, and each is named with its file and field.
// 2. A time field (a duration, a start time) makes two identical passes
//    differ: keys that hold a time are left out by name (TIME_KEY), and
//    nothing else is. The score's `run` (the folder it was read from) is
//    the only other field left out.
// 3. A change of the inputs between the passes (other Semgrep rule pack
//    bytes, other osv.dev advisories) reads as a product that is not
//    deterministic: when the two manifests' `external` records differ, the
//    cause is "input" and each input is named.
// 4. A sample one pass has and the other lacks is missed: the sample files
//    of both passes are listed, and a file only one holds is a difference.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inputDifferences } from "./external.mjs";

// A key that holds a time: `at`, `*_at`, `*_ms`, `*Ms`, `*At`, `timings`
// and `elapsedMin`.
export const TIME_KEY = /(^|_)(at|ms)$|Ms$|At$|^timings$|^elapsedMin$/;

export function withoutTimes(v) {
  if (Array.isArray(v)) return v.map(withoutTimes);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !TIME_KEY.test(k)).map(([k, x]) => [k, withoutTimes(x)]));
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

// Every JSON file under a pass's samples/, by its path in the pass.
function sampleFiles(folder) {
  const root = join(folder, "samples");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => relative(folder, join(e.parentPath, e.name)).split("\\").join("/"));
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
    const x = withoutTimes(readJson(join(a, file)));
    const y = withoutTimes(readJson(join(b, file)));
    if (canonical(x) !== canonical(y)) differences.push(`${file}: ${differingFields(x, y).join(", ")}`);
  }
  const inputs = inputDifferences(readJson(join(a, "manifest.json")).external ?? null, readJson(join(b, "manifest.json")).external ?? null);
  const identical = differences.length === 0;
  return { identical, cause: identical ? null : inputs.length > 0 ? "input" : "product", inputs, differences };
}
