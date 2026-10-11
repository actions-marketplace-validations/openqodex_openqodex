// The results index: one committed file per published run under
// benchmark/index/runs/<run-id>.json. The run folder itself stays on the
// machine that ran (benchmark/results/ is gitignored) and leaves only as one
// asset, <run-id>.tar.gz, on the benchmark-data pre-release; the entry names
// that asset by its sha256 and by a hash of its file list, so a fetched copy
// can be proved to be the published one.
//
// Failure list, written before the code:
// 1. An entry names an asset that is not the published one: the entry holds
//    the asset's sha256, size, file count and list hash, and fetch-run.mjs
//    refuses a download that differs in any of them.
// 2. Two machines hash one folder differently: the list hash is over sorted
//    "path\0sha256\n" lines with forward slashes, never over a tarball's
//    bytes, file times or modes.
// 3. A legacy run (made before the frozen cases and score format v3) is
//    read as a measured, accepted result: legacy entries carry
//    `legacy: true`, no intervals, `accepted: false`, the specs and the
//    scorer commit that wrote their score, and the validator refuses any
//    other combination.
// 4. A hand-edited entry drifts from its shape: entryProblems() lists every
//    missing or malformed field, and writeEntry() and fetch-run.mjs refuse
//    an entry that has any.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchRoot } from "./cases.mjs";

export const INDEX_VERSION = 1;
export const indexRoot = join(benchRoot, "index");
export const runsRoot = join(indexRoot, "runs");
export const resultsRoot = join(benchRoot, "results");
// Where published runs live: one pre-release of the public repository,
// never marked latest. A second container is used when this one is full.
export const REPOSITORY = "openqodex/openqodex";
export const RELEASE = "benchmark-data";

export const assetUrl = (runId, release = RELEASE) => `https://github.com/${REPOSITORY}/releases/download/${release}/${runId}.tar.gz`;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Every file under a folder, as sorted paths with forward slashes.
export function fileList(folder) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(rel === "" ? folder : join(folder, rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) out.push(path);
      else throw new Error(`${join(folder, path)} is neither a file nor a folder; a run holds only files`);
    }
  };
  walk("");
  return out.sort(byBytes);
}

export const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The hash of a file list: sha256 over sorted "path\0sha256\n" lines.
export function listHash(entries) {
  const lines = entries.map((e) => `${e.path}\0${e.sha256}\n`).sort(byBytes);
  return sha256(lines.join(""));
}

// Hashes every file of a folder, or the paths given.
export function hashFolder(folder, paths = fileList(folder)) {
  const entries = paths.map((path) => ({ path, sha256: sha256(readFileSync(join(folder, path))) }));
  return { files: entries.length, listHash: listHash(entries), entries };
}

export const entryPath = (runId) => join(runsRoot, `${runId}.json`);

export function readEntry(runId) {
  const path = entryPath(runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function listEntries() {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot)
    .filter((f) => f.endsWith(".json"))
    .sort(byBytes)
    .map((f) => ({ file: f, entry: JSON.parse(readFileSync(join(runsRoot, f), "utf8")) }));
}

export function writeEntry(entry) {
  const problems = entryProblems(entry);
  if (problems.length > 0) throw new Error(`the index entry for ${entry.runId} is not sound:\n${problems.join("\n")}`);
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(entryPath(entry.runId), `${JSON.stringify(entry, null, 2)}\n`);
  return entryPath(entry.runId);
}

// The headline numbers of one configuration, from a score.json byConfig
// entry. Legacy and v2 scores have no intervals, so `ci` is null.
export function headline(c) {
  const ratio = (r) => ({ hit: r.hit, of: r.of, ci: null });
  return {
    samples: c.samples,
    complete: c.complete,
    incomplete: c.incomplete,
    failed: c.failed,
    recall: ratio(c.recall),
    precision: ratio(c.precision),
    controls: { hit: c.controls.hit, of: c.controls.of },
    falseFindings: c.falseFindings,
    wallMsMean: c.wallMs.mean,
    costUsdMean: c.costUsd.mean,
    costUsdTotal: c.costUsd.total,
  };
}

// A run's last word on how it ended: the last resume's end when it was
// resumed, else the first invocation's.
export function endedOf(manifest, resumes = []) {
  const last = [...resumes].reverse().find((r) => r.event === "ended");
  const e = last ?? manifest.ended ?? {};
  return { how: e.how ?? null, why: e.why ?? null };
}

// The entry for a run, from its manifest and the score file it is cited by.
// `legacy` is that run's recipe (benchmark/legacy/recipes.json), or null.
export function buildEntry({ runId, manifest, resumes, score, asset, privateListHash, legacy = null }) {
  const b = manifest.build ?? {};
  const reviewers = {};
  for (const [name, r] of Object.entries(manifest.reviewers ?? (manifest.reviewer ? { [manifest.reviewer.name]: manifest.reviewer } : {}))) reviewers[name] = { version: r.version ?? null, model: r.model ?? null };
  const scores = {};
  const perCase = {};
  for (const [config, c] of Object.entries(score.byConfig ?? {})) scores[config] = headline(c);
  for (const [name, byConfig] of Object.entries(score.byCase ?? {})) {
    for (const [config, c] of Object.entries(byConfig)) {
      perCase[config] ??= {};
      perCase[config][name] = { recall: [c.recall.hit, c.recall.of], precision: [c.precision.hit, c.precision.of] };
    }
  }
  const caseIds = manifest.caseHashes ? Object.keys(manifest.caseHashes).sort(byBytes).map((name) => `planted/${name}@${manifest.caseHashes[name].slice(0, 8)}`) : null;
  const entry = {
    version: INDEX_VERSION,
    runId,
    date: String(manifest.started_at ?? "").slice(0, 10),
    suite: manifest.suite ?? "planted",
    split: manifest.split ?? "dev",
    splitHash: manifest.splitHash ?? null,
    mode: manifest.mode ?? "review",
    path: manifest.path ?? "laptop",
    build: { commit: b.commit ?? null, short: b.short ?? null, cliVersion: b.cliVersion ?? null, dirty: b.dirty ?? null, bundleHash: b.bundleHash ?? b.bundleSha256 ?? null },
    reviewers,
    configs: manifest.configs ?? Object.keys(scores),
    repeat: manifest.repeat ?? null,
    web: manifest.web ?? manifest.review?.web ?? null,
    caseSetHash: manifest.caseSetHash ?? null,
    caseIds,
    rulesVersion: manifest.rulesVersion ?? null,
    scannersComplete: manifest.scannersComplete ?? null,
    external: manifest.external ?? null,
    ended: endedOf(manifest, resumes),
    release: manifest.release ?? null,
    scores,
    perCase,
    asset,
    accepted: false,
    acceptedAt: null,
    acceptedBy: null,
    legacy: legacy !== null,
    privateListHash,
  };
  if (legacy !== null) {
    const head = legacy.scores.find((s) => s.file === legacy.headline);
    entry.scoreFile = head.file;
    entry.specsFrom = specsLabel(head.specs, runId);
    entry.scorer = { commit: head.scorer.commit, sha256: head.scorer.sha256 };
    entry.scoreFiles = legacy.scores.map((s) => ({ file: s.file, scores: s.scores, specsFrom: specsLabel(s.specs, s.scores), scorer: { commit: s.scorer.commit, sha256: s.scorer.sha256 } }));
    entry.originals = { commit: legacy.originals.commit, path: legacy.originals.path };
    entry.notes = legacy.notes;
  }
  return entry;
}

// Where a score's specs came from, as one label: "cases" (the run's own),
// "cases-v2" (another folder in the run) or "<run-id>/cases".
export const specsLabel = (specs, scoredRun) => (specs.run === scoredRun ? specs.folder : `${specs.run}/${specs.folder}`);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (n, min = 0) => Number.isInteger(n) && n >= min;
const isRatio = (r) => r && isInt(r.hit) && isInt(r.of) && r.hit <= r.of;

// Every problem with an entry, one line each; empty when it is sound.
export function entryProblems(e) {
  const p = [];
  const need = (cond, what) => {
    if (!cond) p.push(`${e?.runId ?? "entry"}: ${what}`);
  };
  need(e && typeof e === "object", "the entry is not an object");
  if (!e || typeof e !== "object") return p;
  need(e.version === INDEX_VERSION, `version must be ${INDEX_VERSION}`);
  need(typeof e.runId === "string" && /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+$/.test(e.runId), "runId must be <date>-<name>");
  need(typeof e.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.runId?.startsWith(e.date), "date must be the run's start date, which the run id begins with");
  need(typeof e.suite === "string" && e.suite !== "", "suite is missing");
  need(e.split === "dev" || e.split === "test", "split must be dev or test");
  need(e.splitHash === null || HEX64.test(e.splitHash ?? ""), "splitHash must be a sha256 or null");
  need(e.mode === "review" || e.mode === "scan", "mode must be review or scan");
  need(e.path === "laptop" || e.path === "server", "path must be laptop or server");
  need(e.build && HEX40.test(e.build.commit ?? "") && typeof e.build.short === "string" && e.build.commit.startsWith(e.build.short) && typeof e.build.dirty === "boolean", "build must name the full commit, its short form and whether the tree was dirty");
  need(e.reviewers && typeof e.reviewers === "object" && Object.values(e.reviewers).every((r) => r && "version" in r && "model" in r), "reviewers must give each reviewer's version and model");
  need(Array.isArray(e.configs) && e.configs.length > 0 && e.configs.every((c) => typeof c === "string"), "configs must list the run's configurations");
  need(isInt(e.repeat, 1), "repeat must be a whole number of at least 1");
  need(e.caseIds === null || (Array.isArray(e.caseIds) && e.caseIds.every((id) => /^[a-z]+\/[^@]+@[0-9a-f]{8}$/.test(id))), "caseIds must be <suite>/<name>@<hash8> ids, or null when the run did not record its case hashes");
  need(e.ended && "how" in e.ended && "why" in e.ended, "ended must say how the run ended");
  need(e.scores && typeof e.scores === "object" && Object.keys(e.scores).length > 0, "scores must hold each configuration's headline numbers");
  for (const [config, s] of Object.entries(e.scores ?? {})) {
    need(e.configs?.includes(config), `scores names ${config}, which configs does not list`);
    need(isRatio(s.recall) && isRatio(s.precision) && isRatio(s.controls), `scores.${config}: recall, precision and controls must be hits over checks`);
    need(isInt(s.samples) && isInt(s.complete) && isInt(s.incomplete) && isInt(s.failed) && s.complete + s.incomplete + s.failed === s.samples, `scores.${config}: complete, incomplete and failed must add up to samples`);
  }
  need(e.perCase && typeof e.perCase === "object", "perCase is missing");
  const a = e.asset ?? {};
  need(typeof a.url === "string" && a.url.endsWith(`/${e.runId}.tar.gz`) && HEX64.test(a.sha256 ?? "") && isInt(a.bytes, 1) && isInt(a.files, 1) && HEX64.test(a.listHash ?? ""), "asset must give the url of <run-id>.tar.gz, its sha256, bytes, file count and list hash");
  need(HEX64.test(e.privateListHash ?? ""), "privateListHash must be the list hash of the full local folder");
  need(typeof e.accepted === "boolean", "accepted must be true or false");
  need(e.accepted || (e.acceptedAt === null && e.acceptedBy === null), "an entry that is not accepted has no acceptedAt or acceptedBy");
  need(typeof e.legacy === "boolean", "legacy must be true or false");
  if (e.legacy) {
    need(e.accepted === false, "a legacy run is never accepted");
    need(Object.values(e.scores ?? {}).every((s) => s.recall?.ci === null && s.precision?.ci === null), "a legacy run has no intervals");
    need(typeof e.scoreFile === "string" && typeof e.specsFrom === "string", "a legacy run names its score file and the specs it read");
    need(e.scorer && HEX40.test(e.scorer.commit ?? "") && HEX64.test(e.scorer.sha256 ?? ""), "a legacy run names the commit of the scorer that wrote its score and that scorer's list hash");
    need(Array.isArray(e.scoreFiles) && e.scoreFiles.some((s) => s.file === e.scoreFile) && e.scoreFiles.every((s) => typeof s.file === "string" && typeof s.scores === "string" && typeof s.specsFrom === "string" && HEX40.test(s.scorer?.commit ?? "") && HEX64.test(s.scorer?.sha256 ?? "")), "scoreFiles must name, for every stored score, the run it scores, its specs and its scorer");
    need(e.originals && HEX40.test(e.originals.commit ?? "") && e.originals.path === `benchmark/results/${e.runId}`, "a legacy run names the commit that held its original folder");
    need(Array.isArray(e.notes), "notes must list what the run did not record");
  }
  return p;
}
