// What a scanner-only run consumed that its build does not fix: the Semgrep
// rule packs semgrep fetched from the registry, the advisories osv-scanner
// got from osv.dev, and the scanner toolchain and versions the bundle pins.
// Recorded in the manifest's `external`, so a score that moved because an
// input moved is not read as a product change.
//
// Failure list, written before the code:
// 1. Two samples of one run are scanned with different Semgrep rule packs
//    and the run is scored as one rule set: the complete set of packs each
//    sample's scan recorded (the adapter's `rules`, by pack and the sha256
//    of its rules) is compared, never a union of them, and a run whose
//    samples' sets differ in any pack or sha256 is "mixed", which accept
//    refuses. The raw size is not compared: one rule set comes as JSON or
//    as YAML, of other sizes.
// 2. A sample whose packs were not recorded, or recorded as an empty list,
//    is taken as matching the others: the run's packs are then "unknown",
//    and accept refuses a scan run with unknown packs too.
// 3. osv.dev answers differently between two runs and the change reads as a
//    product change: what osv-scanner returned in each sample (its status,
//    every raw finding in the scan trail by advisory id and severity, and
//    each kept candidate's message) is hashed, and a comparison names a
//    changed hash as an input change. osv-scanner's modified times are not
//    in the scan record, so the hash is over what the record holds.
// 4. The run downloads its own copy of the packs or the advisories to
//    record them, and records something the scans never used: nothing here
//    downloads. Every value is read from the samples' saved scans, and the
//    toolchain hash and versions from the doctor record of the bundle the
//    run used.
// 5. A machine path lands in the published manifest: a missing scanner's
//    reason is kept with the home folder written as ~, and a ready
//    scanner's tool path is never kept.
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const OSV_BASIS = "sha256 over each sample's osv-scanner status and what osv-scanner returned there: each raw finding in the scan trail by advisory id and severity, and each kept candidate's message. osv-scanner's modified times are not in the scan record.";

// The scanners of the bundle a run uses, from `openqodex doctor --json`
// run in the run's own home: the toolchain hash, each scanner's pinned
// version, and every scanner that is not ready with its state and reason.
export function toolchainOf(doctor, { home = homedir() } = {}) {
  if (!doctor || typeof doctor.toolchain !== "string" || !Array.isArray(doctor.scanners)) throw new Error("openqodex doctor --json gave no toolchain hash or scanner list");
  const hide = (text) => (typeof text === "string" && home ? text.split(home).join("~") : (text ?? null));
  const sorted = [...doctor.scanners].sort((a, b) => byText(a.scanner, b.scanner));
  return {
    toolchainHash: doctor.toolchain,
    scannerVersions: Object.fromEntries(sorted.map((s) => [s.scanner, s.version])),
    missing: sorted.filter((s) => s.state !== "ready").map((s) => ({ scanner: s.scanner, state: s.state, detail: hide(s.detail) })),
  };
}

// The Semgrep rule packs a run's scans consumed: the packs, sorted, each as
// { pack, sha256 }, when every sample in which semgrep ran consumed the same
// set of packs with the same rules; "mixed" when two samples' sets differ in
// any pack or sha256, or one sample read two versions of one pack; "unknown"
// when a sample in which semgrep ran recorded no pack (no record, or an
// empty one). [] when semgrep ran nowhere. The sha256 is of the pack's rules
// in a normal form; the raw size (`bytes`) is not compared or kept, because
// the registry serves one rule set as JSON or as YAML, of other sizes.
export function semgrepPacksOf(scans) {
  const sets = new Set();
  let first = null;
  let unknown = false;
  for (const scan of scans) {
    const s = (scan?.scanners ?? []).find((x) => x.scanner === "semgrep");
    if (!s || s.status !== "ran") continue;
    if (!Array.isArray(s.rules) || s.rules.length === 0) {
      unknown = true;
      continue;
    }
    // One pack read twice with other rules, in one sample, is two rule sets already.
    const byPack = new Map();
    for (const r of s.rules) {
      const had = byPack.get(r.pack);
      if (had && had.sha256 !== r.sha256) return "mixed";
      byPack.set(r.pack, { pack: r.pack, sha256: r.sha256 });
    }
    const set = [...byPack.values()].sort((a, b) => byText(a.pack, b.pack));
    sets.add(JSON.stringify(set));
    if (sets.size > 1) return "mixed";
    first ??= set;
  }
  if (unknown) return "unknown";
  return first ?? [];
}

// What osv-scanner returned across a run's samples ({ caseId, scan }), as
// one hash and the number of distinct advisories.
export function osvAdvisoriesOf(samples) {
  const lines = new Set();
  const advisories = new Set();
  const prefix = "osv-scanner:";
  for (const { caseId, scan } of samples) {
    const s = (scan?.scanners ?? []).find((x) => x.scanner === "osv-scanner");
    lines.add(`${caseId}\tstatus\t${scan ? (s?.status ?? "absent") : "no scan"}`);
    for (const t of scan?.trail ?? []) {
      if (!String(t.token).startsWith(prefix)) continue;
      const id = t.token.slice(prefix.length);
      advisories.add(id);
      lines.add(`${caseId}\t${id}\t${t.severity}`);
    }
    for (const c of scan?.candidates ?? []) {
      if (c.source !== "osv-scanner") continue;
      advisories.add(c.ruleId);
      lines.add(`${caseId}\t${c.ruleId}\t${c.severity}\t${c.message}`);
    }
  }
  return { sha256: sha256([...lines].sort(byText).join("\n")), advisories: advisories.size, basis: OSV_BASIS };
}

// The manifest's `external` for a run: `samples` are the first attempts,
// { caseId, startedAt, scan }, and `preflight` is toolchainOf's record.
export function externalOf({ samples, preflight }) {
  const asked = samples.filter((s) => (s.scan?.scanners ?? []).some((x) => x.scanner === "osv-scanner" && x.status === "ran")).map((s) => s.startedAt).filter((t) => typeof t === "string").sort(byText);
  return {
    toolchainHash: preflight.toolchainHash,
    semgrepPacks: semgrepPacksOf(samples.map((s) => s.scan)),
    osvAdvisories: osvAdvisoriesOf(samples),
    // The first and the last sample in which osv-scanner asked osv.dev.
    osvQueriedAt: asked.length === 0 ? null : { from: asked[0], to: asked[asked.length - 1] },
    scannerVersions: preflight.scannerVersions,
  };
}

const describePacks = (p) => (Array.isArray(p) ? (p.length === 0 ? "none" : p.map((x) => `${x.pack} ${String(x.sha256).slice(0, 12)}`).join(", ")) : String(p ?? "not recorded"));

// Every input that differs between two runs' `external` records, one line
// each, each labelled as an input, never the product's.
export function inputDifferences(a, b) {
  if (!a && !b) return [];
  if (!a || !b) return ["input: one run records its external inputs (rule packs, advisories, toolchain) and the other does not"];
  const out = [];
  const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  if (!same(a.toolchainHash, b.toolchainHash)) out.push(`input: the pinned scanner toolchain differs (${String(a.toolchainHash).slice(0, 12)} then ${String(b.toolchainHash).slice(0, 12)})`);
  if (!same(a.scannerVersions, b.scannerVersions)) {
    const names = [...new Set([...Object.keys(a.scannerVersions ?? {}), ...Object.keys(b.scannerVersions ?? {})])].sort(byText);
    const moved = names.filter((n) => a.scannerVersions?.[n] !== b.scannerVersions?.[n]).map((n) => `${n} ${a.scannerVersions?.[n] ?? "none"} then ${b.scannerVersions?.[n] ?? "none"}`);
    out.push(`input: the scanner versions differ: ${moved.join(", ")}`);
  }
  if (!same(a.semgrepPacks, b.semgrepPacks)) out.push(`input: the Semgrep rule packs differ: ${describePacks(a.semgrepPacks)}, then ${describePacks(b.semgrepPacks)}`);
  if (!same(a.osvAdvisories?.sha256, b.osvAdvisories?.sha256)) out.push(`input: the osv.dev advisory data differs: ${a.osvAdvisories?.advisories ?? "?"} advisories (${String(a.osvAdvisories?.sha256).slice(0, 12)}), then ${b.osvAdvisories?.advisories ?? "?"} (${String(b.osvAdvisories?.sha256).slice(0, 12)})`);
  return out;
}

// Why an index entry cannot be accepted for what it consumed; empty when it
// can. trend.mjs --accept adds these to its own refusals.
export function externalRefusals(e) {
  const out = [];
  const packs = e?.external?.semgrepPacks;
  if (packs === "mixed") out.push("its samples consumed different Semgrep rule packs (external.semgrepPacks is mixed), so its scores mix two rule sets; run it again");
  else if (e?.mode === "scan" && (packs === undefined || packs === null || packs === "unknown")) out.push("the Semgrep rule packs its samples consumed are not recorded (external.semgrepPacks is unknown), so a later run could not tell a rule change from a product change");
  return out;
}
