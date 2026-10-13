// AACR-Bench's pull requests into the aacr suite and its split.
//
//   node benchmark/ingest/aacr.mjs [--offline]
//   node benchmark/ingest/aacr.mjs --data-only
//   node benchmark/ingest/aacr.mjs --freeze-merge-base <name>
//
// Reads the pinned data files named in benchmark/outside/boards.json (the
// cache keeps them under $OPENQODEX_BENCH_CACHE/raw/<board>/<path>), asks
// GitHub once per repository for its licence, current name and fork source
// (lib/licence.mjs, cached), and writes:
//   benchmark/suites/aacr/cases.json         one entry per pull request: links,
//                                            commits, licence, group, hashes;
//                                            never a comment's text
//   benchmark/suites/aacr/ingest-report.txt  every exclusion and reservation
//                                            with its count (also printed)
//   benchmark/splits/aacr-v1.json            the split (PLAN-benchmark 4.10)
// --offline reads only the cache and stops at the first thing missing.
// --data-only puts the two pinned AACR-Bench data files in the cache, which
// is what a run needs to read its cases' truth (lib/suites.mjs truthOf), and
// does nothing else: no GitHub answer is asked for and no file of this
// repository is written.
// --freeze-merge-base <name> freezes the merge base of a case whose base and
// head have more than one, which the materialiser refuses until one is
// frozen: the newest by committer date, then the smaller commit id
// (docs/benchmark.md, "Two merge bases"; lib/suites.mjs freezeMergeBase), so
// every machine freezes the same one. It fetches commits only from the
// case's clone URL into the clone cache and rewrites that case's entry in
// cases.json, with its new hash and id; a later ingest keeps it.
//
// Failure list, written before the code:
// 1. An upstream edit to the dataset changes the truth under a frozen id:
//    every data file, downloaded or cached, must hash to its pin, or the
//    ingest stops and keeps nothing of it; each case's id carries a hash
//    over its truth hash (lib/suites.mjs).
// 2. A pull request with no licence is used: a repository whose licence is
//    none or unknown has every pull request excluded, with the reason in the
//    entry and the count in the report.
// 3. One repository group's pull requests land on both sides of the split:
//    the split assigns groups, never pull requests. A group joins a
//    repository with its renames and fork source (GitHub's answer), every
//    repository of the same name, and the repositories Martian names as the
//    originals of its evaluation copies.
// 4. A repository group holding a Martian or ReviewBench pull request lands
//    in development: every such group goes to held-out before any group is
//    hashed, and the report names each with the pull requests that put it
//    there and any AACR pull request that is the same pull request.
// 5. The laptop sample is the smallest changes: dev-laptop takes 12
//    development pull requests from each third by change size.
// 6. Two ingests of the same pins and cache write different files: nothing
//    here reads the clock, the order of a Map or a directory listing; every
//    list is sorted, and a split file already written is only ever extended
//    (lib/suites.mjs splitRewriteProblems): a moved case, a dropped case or
//    a changed subset needs a new split, which is a new file.
// 9. A pull request that becomes usable moves a case the split already
//    placed, or changes an id: an unverified licence is used and published
//    like any other (Sid, 2026-10-12). With the split file it read
//    (previousSplit), the ingest keeps every placed group on its side and
//    every subset as it was, and places only the new groups, by the same
//    rule, counting the groups already placed. Licence and status are not
//    hashed, so no id changes. A group a reservation now reaches that the
//    earlier split placed in development stops the ingest: that needs a new
//    split.
// 7. A person's frozen matchSignatures are lost on a re-ingest: an entry
//    whose truth hash is unchanged keeps them.
// 8. A pull request whose head the host no longer serves (pushed over after
//    the dataset was made) is offered to a run: GitHub is asked once per
//    head (cached), and such a case is excluded with the reason, the way a
//    licence exclusion is. Status is not hashed, so no id changes, and the
//    split is made from the licensed pull requests, so the split file stays
//    as it was; listCases skips the excluded names it still lists.
// 10. A run's truth files are fetched by an ingest that also rewrites the
//    committed suite and asks GitHub about every repository: --data-only
//    (fetchData) fetches the two pinned files, checked against their pins,
//    and nothing else.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot } from "../lib/cases.mjs";
import { cacheRoot, commitAnswer, licenceExclusion, licenceNote, licenceRecord, repoAnswer } from "../lib/licence.mjs";
import { AACR_CATEGORIES, HASHED, SUITES, aacrTruth, checkPinned, entryHash, freezeMergeBase, rawPath, realCaseId, sha256, splitRewriteProblems, truthHashOf } from "../lib/suites.mjs";

export const SALT = "openqodex-aacr-split-v1";
export const SPLIT_NAME = "aacr-v1";
export const SHARE = { dev: 0.8, test: 0.2 };
export const LAPTOP_PER_THIRD = 12;
export const SMOKE = 5;
export const HEAD_GONE = "head no longer served by the host";
const BOARDS_PATH = join(benchRoot, "outside", "boards.json");

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/;
const REPO_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/;
const key = (repo) => repo.toLowerCase();
const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const prRef = (url) => {
  const m = PR_URL.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (n, of) => (of === 0 ? "0.0" : ((100 * n) / of).toFixed(1));

// ---------- pinned files ----------

export async function fetchPinned(cache, board, pin, { offline }) {
  const path = rawPath(cache, board, pin);
  if (existsSync(path)) return checkPinned(readFileSync(path), pin, path);
  if (offline) throw new Error(`${pin.path} of board ${board} is not in the cache (${path}), and the ingest is offline`);
  let res;
  try {
    res = await fetch(pin.url);
  } catch (error) {
    throw new Error(`downloading ${pin.url} failed: ${error.message}`);
  }
  if (!res.ok) throw new Error(`downloading ${pin.url} answered HTTP ${res.status}`);
  const bytes = checkPinned(Buffer.from(await res.arrayBuffer()), pin, pin.url);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
  return bytes;
}

// ---------- rows ----------

// Why a row cannot be a case, or null.
function rowProblem(r) {
  if (!r || typeof r !== "object") return "the row is not an object";
  if (!PR_URL.test(r.githubPrUrl ?? "")) return `githubPrUrl ${JSON.stringify(r.githubPrUrl)} is not a pull request link`;
  for (const k of ["source_commit", "target_commit"]) if (!/^[0-9a-f]{40}$/.test(r[k] ?? "")) return `${k} is not a 40-hex commit`;
  if (!Number.isInteger(r.change_line_count) || r.change_line_count < 0) return "change_line_count is not a count";
  if (typeof r.project_main_language !== "string" || r.project_main_language === "") return "project_main_language is missing";
  if (!Array.isArray(r.comments)) return "comments is not a list";
  for (const [i, c] of r.comments.entries()) {
    if (typeof c?.path !== "string" || c.path === "") return `comment ${i + 1} has no path`;
    if (c.side !== "right" && c.side !== "left") return `comment ${i + 1} has side ${JSON.stringify(c.side)}`;
    if (!Number.isInteger(c.from_line) || !Number.isInteger(c.to_line) || c.from_line < 1 || c.to_line < 1) return `comment ${i + 1} has no line range`;
    if (typeof c.note !== "string" || c.note.trim() === "") return `comment ${i + 1} has no text`;
  }
  return null;
}

const rowKey = (r) => `${r.githubPrUrl}\0${r.target_commit}`;

// ---------- groups ----------

export class UnionFind {
  constructor() {
    this.up = new Map();
  }
  add(x) {
    if (!this.up.has(x)) this.up.set(x, x);
  }
  find(x) {
    this.add(x);
    let r = x;
    while (this.up.get(r) !== r) r = this.up.get(r);
    while (this.up.get(x) !== r) {
      const next = this.up.get(x);
      this.up.set(x, r);
      x = next;
    }
    return r;
  }
  union(a, b) {
    const [ra, rb] = [this.find(a), this.find(b)];
    if (ra === rb) return;
    if (byBytes(ra, rb) < 0) this.up.set(rb, ra);
    else this.up.set(ra, rb);
  }
}

// Picks `count` names from `ordered`, one language at a time: each round
// takes the first remaining name of every language not yet taken that round.
function spread(ordered, languageOf, count) {
  const left = [...ordered];
  const picked = [];
  while (picked.length < count && left.length > 0) {
    const round = new Set();
    for (let i = 0; i < left.length && picked.length < count; ) {
      const lang = languageOf(left[i]);
      if (round.has(lang)) {
        i++;
        continue;
      }
      round.add(lang);
      picked.push(left[i]);
      left.splice(i, 1);
    }
  }
  return picked;
}

// ---------- the ingest ----------

// The pins of AACR-Bench's two data files: the accepted comments and the
// rejected ones.
function dataPins(boards) {
  const pinOf = (path) => {
    const pin = boards.boards.aacr.data.find((d) => d.path.endsWith(path));
    if (!pin) throw new Error(`benchmark/outside/boards.json pins no ${path} for aacr`);
    return pin;
  };
  return { positive: pinOf("positive_samples.json"), negative: pinOf("negative_samples.json") };
}

// The two pinned data files into the cache, each checked against its pin,
// and nothing else (failure 10). Returns each file's path and whether it was
// downloaded now.
export async function fetchData({ boards, cache = cacheRoot(), offline = false }) {
  const out = [];
  for (const pin of Object.values(dataPins(boards))) {
    const had = existsSync(rawPath(cache, "aacr", pin));
    await fetchPinned(cache, "aacr", pin, { offline });
    out.push({ path: pin.path, downloaded: !had });
  }
  return out;
}

export async function ingestAacr({ boards, cache = cacheRoot(), offline = false, previous = null, previousSplit = null, log = () => {} }) {
  const aacr = boards.boards.aacr;
  const martian = boards.boards.martian;
  const reviewbench = boards.boards.reviewbench;
  const pins = dataPins(boards);

  const positive = JSON.parse((await fetchPinned(cache, "aacr", pins.positive, { offline })).toString("utf8"));
  const negative = JSON.parse((await fetchPinned(cache, "aacr", pins.negative, { offline })).toString("utf8"));
  const golden = [];
  for (const pin of martian.data) golden.push(...JSON.parse((await fetchPinned(cache, "martian", pin, { offline })).toString("utf8")));
  if (!Array.isArray(positive) || !Array.isArray(negative)) throw new Error("an AACR data file is not a list of pull requests");

  // Rows that cannot be cases, each with its reason.
  const notCases = [];
  const urlCount = new Map();
  for (const r of positive) urlCount.set(r?.githubPrUrl, (urlCount.get(r?.githubPrUrl) ?? 0) + 1);
  const keyable = (r) => r && typeof r === "object" && typeof r.githubPrUrl === "string" && typeof r.target_commit === "string";
  const negByKey = new Map();
  const negCount = new Map();
  const negBad = new Map();
  for (const r of negative) {
    if (!keyable(r)) {
      notCases.push({ ref: "(a rejected row with no link)", why: rowProblem(r) });
      continue;
    }
    const k = rowKey(r);
    negCount.set(k, (negCount.get(k) ?? 0) + 1);
    const problem = rowProblem(r);
    if (problem) negBad.set(k, problem);
    else negByKey.set(k, r);
  }
  const posKeys = new Set(positive.filter(keyable).map(rowKey));
  const rows = [];
  for (const r of positive) {
    let problem = rowProblem(r);
    if (!problem && urlCount.get(r.githubPrUrl) > 1) problem = `the pull request appears ${urlCount.get(r.githubPrUrl)} times in ${pins.positive.path}`;
    if (!problem && r.comments.length === 0) problem = "it has no accepted comment";
    if (!problem && negCount.get(rowKey(r)) > 1) problem = `its rejected comments appear ${negCount.get(rowKey(r))} times in ${pins.negative.path}`;
    if (!problem && negBad.has(rowKey(r))) problem = `its rejected comments are malformed: ${negBad.get(rowKey(r))}`;
    if (problem) {
      notCases.push({ ref: r?.githubPrUrl ?? "(no link)", why: problem });
      continue;
    }
    rows.push(r);
  }
  const negativeOnly = [];
  for (const r of negative) {
    if (!keyable(r) || posKeys.has(rowKey(r))) continue;
    if (negBad.has(rowKey(r))) notCases.push({ ref: r.githubPrUrl, why: `a rejected row with no accepted row, malformed: ${negBad.get(rowKey(r))}` });
    else negativeOnly.push({ ref: prRef(r.githubPrUrl), comments: r.comments.length });
  }

  // GitHub's answers: licence for AACR repositories, names and forks for all.
  const aacrRepos = [...new Set(rows.map((r) => `${PR_URL.exec(r.githubPrUrl)[1]}/${PR_URL.exec(r.githubPrUrl)[2]}`))].sort(byBytes);
  const reservedUrls = [];
  for (const [board, list] of [["martian", martian.reservedPrUrls], ["reviewbench", reviewbench.reservedPrUrls]]) {
    if (!Array.isArray(list)) throw new Error(`benchmark/outside/boards.json has no reserved pull request list for ${board}, so nothing can be reserved; refusing to split`);
    for (const url of list) reservedUrls.push({ board, prUrl: url });
  }
  const originals = golden.filter((g) => typeof g?.original_url === "string" && REPO_URL.test(g.original_url)).map((g) => ({ copy: g.url, original: g.original_url }));
  const badLinks = reservedUrls.filter((r) => !PR_URL.test(r.prUrl));
  const repoOfUrl = (url) => {
    const m = REPO_URL.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  };
  const otherRepos = [...new Set([...reservedUrls.map((r) => repoOfUrl(r.prUrl)), ...originals.map((o) => repoOfUrl(o.original))].filter(Boolean))].filter((r) => !aacrRepos.some((a) => key(a) === key(r))).sort(byBytes);
  const answers = new Map();
  let asked = 0;
  for (const repo of aacrRepos) {
    answers.set(key(repo), repoAnswer(repo, { cache, offline, licence: true }));
    if (++asked % 25 === 0) log(`GitHub's answer ready, from the cache or GitHub, for ${asked} repositories`);
  }
  for (const repo of otherRepos) {
    answers.set(key(repo), repoAnswer(repo, { cache, offline }));
    if (++asked % 25 === 0) log(`GitHub's answer ready, from the cache or GitHub, for ${asked} repositories`);
  }

  // Groups.
  const uf = new UnionFind();
  const byName = new Map();
  const node = (repo) => {
    const k = key(repo);
    uf.add(k);
    const name = k.split("/")[1];
    if (byName.has(name)) uf.union(byName.get(name), k);
    else byName.set(name, k);
    return k;
  };
  for (const repo of [...aacrRepos, ...otherRepos]) {
    const k = node(repo);
    const a = answers.get(k);
    if (a?.found && a.fullName) uf.union(k, node(a.fullName));
    if (a?.found && a.fork && a.source) uf.union(k, node(a.source));
  }
  for (const o of originals) {
    const [copy, original] = [repoOfUrl(o.copy), repoOfUrl(o.original)];
    if (copy && original) uf.union(node(copy), node(original));
  }
  const current = (repo) => {
    const a = answers.get(key(repo));
    return a?.found && a.fullName ? key(a.fullName) : key(repo);
  };
  const aacrRoots = new Map();
  for (const repo of aacrRepos) {
    const root = uf.find(key(repo));
    if (!aacrRoots.has(root) || byBytes(key(repo), aacrRoots.get(root)) < 0) aacrRoots.set(root, key(repo));
  }
  const groupOfRepo = (repo) => aacrRoots.get(uf.find(key(repo))) ?? null;
  const membersOf = new Map();
  for (const k of uf.up.keys()) {
    const g = aacrRoots.get(uf.find(k));
    if (!g) continue;
    if (!membersOf.has(g)) membersOf.set(g, []);
    membersOf.get(g).push(k);
  }

  // Reservation: every pull request of a reserved list, and Martian's
  // originals, mark their group.
  const reservedOf = new Map();
  const mark = (repo, why) => {
    const g = groupOfRepo(repo);
    if (!g) return false;
    if (!reservedOf.has(g)) reservedOf.set(g, []);
    reservedOf.get(g).push(why);
    return true;
  };
  const reached = { martian: new Set(), reviewbench: new Set() };
  const originalOf = new Map(originals.map((o) => [o.copy, o.original]));
  for (const r of reservedUrls) {
    const repo = repoOfUrl(r.prUrl);
    const why = originalOf.has(r.prUrl) && r.board === "martian" ? { board: r.board, prUrl: r.prUrl, original: originalOf.get(r.prUrl) } : { board: r.board, prUrl: r.prUrl };
    if (repo && mark(repo, why)) reached[r.board].add(groupOfRepo(repo));
  }
  // An original whose evaluation copy is not on the reserved list still
  // reserves its own group.
  const listed = new Set(reservedUrls.filter((r) => r.board === "martian").map((r) => r.prUrl));
  for (const o of originals.filter((x) => !listed.has(x.copy))) {
    const repo = repoOfUrl(o.original);
    if (repo && mark(repo, { board: "martian", prUrl: o.copy, original: o.original })) reached.martian.add(groupOfRepo(repo));
  }
  const normPr = (url) => {
    const m = PR_URL.exec(url);
    return m ? `${current(`${m[1]}/${m[2]}`)}#${m[3]}` : null;
  };
  const reservedPrs = new Map();
  for (const r of reservedUrls) if (normPr(r.prUrl)) reservedPrs.set(normPr(r.prUrl), `${r.board === "martian" ? "Martian" : "ReviewBench"}`);
  for (const o of originals) if (normPr(o.original)) reservedPrs.set(normPr(o.original), `Martian: the original of ${prRef(o.copy)}`);

  // Entries.
  const prevByName = new Map((previous?.cases ?? []).map((e) => [e.name, e]));
  const entries = [];
  // The pull requests whose licence allows them: the population the split
  // is made from. A head the host no longer serves is excluded after the
  // split, so losing one never moves a group or rewrites the split file.
  const licensed = new Set();
  let headsAsked = 0;
  for (const r of rows) {
    const m = PR_URL.exec(r.githubPrUrl);
    const repo = `${m[1]}/${m[2]}`;
    const name = `${m[1]}__${m[2]}-${m[3]}`;
    const truth = aacrTruth(r, negByKey.get(rowKey(r)));
    const truthHash = truthHashOf(truth.items);
    const answer = answers.get(key(repo));
    const licence = licenceRecord(answer);
    const licenceWhy = answer?.found ? licenceExclusion(licence) : "GitHub does not know the repository (deleted, private, or moved without a redirect), so neither its licence nor its code can be read";
    let excludedWhy = licenceWhy;
    if (licenceWhy === null) {
      licensed.add(name);
      if (!commitAnswer(repo, r.target_commit, { cache, offline }).served) excludedWhy = `${HEAD_GONE}: GitHub no longer has the head commit ${r.target_commit.slice(0, 12)} of ${repo} (the pull request was pushed over after the dataset was made), so its code cannot be fetched`;
      if (++headsAsked % 25 === 0) log(`GitHub's answer ready, from the cache or GitHub, for ${headsAsked} head commits`);
    }
    const prev = prevByName.get(name);
    const entry = {
      name,
      id: null,
      hash: null,
      status: excludedWhy ? "excluded" : "usable",
      excludedWhy,
      prUrl: r.githubPrUrl,
      repo,
      cloneUrl: `https://github.com/${repo}.git`,
      prRef: `refs/pull/${m[3]}/head`,
      baseSha: r.source_commit,
      headSha: r.target_commit,
      mergeBaseSha: prev && prev.headSha === r.target_commit && prev.baseSha === r.source_commit ? (prev.mergeBaseSha ?? null) : null,
      language: r.project_main_language,
      changeLines: r.change_line_count,
      repoGroup: groupOfRepo(repo),
      licence,
      truth: { kind: truth.kind, accepted: truth.items.filter((t) => t.valid).length, rejected: truth.items.filter((t) => !t.valid).length },
      truthHash,
      matchSignatures: prev && prev.truthHash === truthHash ? (prev.matchSignatures ?? {}) : {},
    };
    entry.hash = entryHash(entry);
    entry.id = realCaseId("aacr", name, entry.hash);
    entries.push(entry);
  }
  entries.sort((a, b) => byBytes(a.name, b.name));
  const usable = entries.filter((e) => e.status === "usable");
  const splitPool = entries.filter((e) => licensed.has(e.name));

  // Split.
  const groups = new Map();
  for (const e of splitPool) {
    if (!groups.has(e.repoGroup)) groups.set(e.repoGroup, { group: e.repoGroup, names: [], languages: new Map() });
    const g = groups.get(e.repoGroup);
    g.names.push(e.name);
    g.languages.set(e.language, (g.languages.get(e.language) ?? 0) + 1);
  }
  const languageOfGroup = (g) => [...g.languages.entries()].sort((a, b) => b[1] - a[1] || byBytes(a[0], b[0]))[0][0];
  // Groups an earlier version of this split file placed keep their side and
  // their language; only the other groups are placed below (failure 9).
  const placed = new Map((previousSplit?.groups ?? []).map((g) => [g.group, g]));
  const sideOf = new Map();
  const byLanguage = new Map();
  for (const g of groups.values()) {
    g.language = placed.get(g.group)?.language ?? languageOfGroup(g);
    g.reserved = reservedOf.has(g.group) ? reservedOf.get(g.group).sort((a, b) => byBytes(a.board, b.board) || byBytes(a.prUrl, b.prUrl)) : null;
    g.order = g.reserved ? null : sha256(`${SALT}\0${g.group}`);
    if (!byLanguage.has(g.language)) byLanguage.set(g.language, []);
    byLanguage.get(g.language).push(g);
  }
  const perLanguage = [];
  for (const [language, list] of [...byLanguage.entries()].sort((a, b) => byBytes(a[0], b[0]))) {
    const total = list.reduce((n, g) => n + g.names.length, 0);
    const count = { dev: 0, test: 0, reservedTest: 0 };
    for (const g of list.filter((x) => placed.has(x.group))) {
      const side = placed.get(g.group).split;
      if (g.reserved && side !== "test") throw new Error(`the group ${g.group} now holds a reserved pull request (${g.reserved.map((r) => prRef(r.prUrl)).join(", ")}), but ${SPLIT_NAME} placed it in development; a new split is a new file: write it as ${SPLIT_NAME.replace(/\d+$/, (n) => String(Number(n) + 1))} with its own salt`);
      sideOf.set(g.group, side);
      count[side] += g.names.length;
      if (g.reserved) count.reservedTest += g.names.length;
    }
    for (const g of list.filter((x) => !placed.has(x.group) && x.reserved)) {
      sideOf.set(g.group, "test");
      count.test += g.names.length;
      count.reservedTest += g.names.length;
    }
    // A group goes to held-out only while held-out stays within half a pull
    // request of its share, so one large group cannot push a language far
    // past 20% (sending each group to the side further below its share gave
    // 30% held-out on AACR's few, uneven groups).
    for (const g of list.filter((x) => !placed.has(x.group) && !x.reserved).sort((a, b) => byBytes(a.order, b.order))) {
      const side = count.test + g.names.length <= SHARE.test * total + 0.5 ? "test" : "dev";
      sideOf.set(g.group, side);
      count[side] += g.names.length;
    }
    perLanguage.push({ language, total, ...count });
  }
  const dev = splitPool.filter((e) => sideOf.get(e.repoGroup) === "dev").map((e) => e.name).sort(byBytes);
  const test = splitPool.filter((e) => sideOf.get(e.repoGroup) === "test").map((e) => e.name).sort(byBytes);

  // Subsets.
  const entryOf = new Map(entries.map((e) => [e.name, e]));
  const bySize = (a, b) => entryOf.get(a).changeLines - entryOf.get(b).changeLines || byBytes(a, b);
  const devBySize = [...dev].sort(bySize);
  const thirds = [0, 1, 2].map((k) => devBySize.slice(Math.floor((devBySize.length * k) / 3), Math.floor((devBySize.length * (k + 1)) / 3)));
  const languageOf = (n) => entryOf.get(n).language;
  // An earlier version of this split file keeps its subsets as they were.
  const laptop = previousSplit?.subsets?.["dev-laptop"] ?? thirds.flatMap((third) => spread([...third].sort((a, b) => byBytes(sha256(`${SALT}\0dev-laptop\0${a}`), sha256(`${SALT}\0dev-laptop\0${b}`))), languageOf, LAPTOP_PER_THIRD)).sort(byBytes);
  const smoke = previousSplit?.subsets?.["dev-smoke"] ?? spread(devBySize, languageOf, SMOKE).sort(byBytes);

  const groupList = [...groups.values()].sort((a, b) => byBytes(a.group, b.group));
  const reservedGroups = groupList.filter((g) => g.reserved);
  const listHash = (list) => sha256(`${[...list].sort(byBytes).join("\n")}\n`);
  const split = {
    version: 1,
    name: SPLIT_NAME,
    suite: "aacr",
    rule: "The unit is the repository group: a repository with its renames and fork source as GitHub names them, every repository of the same name, and the repositories Martian names as the originals of its evaluation copies. Every group holding a Martian or ReviewBench pull request goes to held-out first. Within each language, the other groups, ordered by sha256(salt, NUL, group), are taken one at a time: a group goes to held-out while held-out stays within half a pull request of 20% of that language's usable pull requests (counting the reserved ones), and to development otherwise. dev-laptop takes 12 development pull requests from each third by change size, in seeded order, one language at a time. dev-smoke takes the smallest development pull requests, one language at a time. The file is only ever extended: a group an earlier version placed keeps its side and language, the subsets stay as they were, and a new group (such as one whose licence became usable) is placed by the rule above, counting the groups already placed.",
    salt: SALT,
    share: SHARE,
    dataset: { repo: aacr.repo, revision: aacr.commit, positive: pins.positive.sha256, negative: pins.negative.sha256 },
    reservedFrom: {
      martian: { repo: martian.repo, commit: martian.commit, prUrls: martian.reservedPrUrls.length, listSha256: listHash(martian.reservedPrUrls), originals: originals.length },
      reviewbench: { repo: reviewbench.repo, commit: reviewbench.commit, prUrls: reviewbench.reservedPrUrls.length, listSha256: listHash(reviewbench.reservedPrUrls) },
    },
    groups: groupList.map((g) => ({ group: g.group, members: membersOf.get(g.group).sort(byBytes), language: g.language, prs: g.names.length, split: sideOf.get(g.group), reserved: g.reserved, order: g.order })),
    cases: { dev, test },
    subsets: { "dev-laptop": laptop, "dev-smoke": smoke },
    counts: { usable: splitPool.length, dev: dev.length, test: test.length, reserved: reservedGroups.reduce((n, g) => n + g.names.length, 0), groups: { dev: groupList.filter((g) => sideOf.get(g.group) === "dev").length, test: groupList.filter((g) => sideOf.get(g.group) === "test").length, reserved: reservedGroups.length } },
  };

  const suite = {
    version: 1,
    suite: "aacr",
    dataset: { name: "AACR-Bench", repo: aacr.repo, url: aacr.source, revision: aacr.commit, licence: aacr.licence, files: { positive: { path: pins.positive.path, sha256: pins.positive.sha256 }, negative: { path: pins.negative.path, sha256: pins.negative.sha256 } } },
    hashCovers: HASHED,
    cases: entries,
  };

  // The report.
  const lines = [];
  const say = (s = "") => lines.push(s);
  const accepted = rows.reduce((n, r) => n + r.comments.length, 0);
  say(`AACR-Bench ingest: ${aacr.repo} at ${aacr.commit} (${aacr.licence})`);
  say(`${pins.positive.path} sha256 ${pins.positive.sha256}: ${plural(positive.length, "pull request")}, ${plural(positive.reduce((n, r) => n + (Array.isArray(r?.comments) ? r.comments.length : 0), 0), "accepted comment")}`);
  say(`${pins.negative.path} sha256 ${pins.negative.sha256}: ${plural(negative.length, "pull request")}, ${plural(negative.reduce((n, r) => n + (Array.isArray(r?.comments) ? r.comments.length : 0), 0), "rejected comment")}`);
  say();
  say(`Cases: ${plural(entries.length, "pull request")} in ${plural(aacrRepos.length, "repository", "repositories")}, ${accepted} accepted comments. Usable: ${usable.length}. Excluded: ${entries.length - usable.length}.`);
  say("Excluded, by reason:");
  const reasons = [
    ["licence none (no licence file)", (e) => e.licence.class === "none" && e.excludedWhy?.startsWith("licence none")],
    ["licence of no class this benchmark uses", (e) => e.excludedWhy?.startsWith("licence ") && !e.excludedWhy.startsWith("licence none")],
    ["repository unknown to GitHub", (e) => e.excludedWhy?.startsWith("GitHub does not know")],
    [`${HEAD_GONE} (excluded after the split; the split file still lists them)`, (e) => e.excludedWhy?.startsWith(HEAD_GONE)],
  ];
  for (const [label, test] of reasons) {
    const hit = entries.filter((e) => e.status === "excluded" && test(e));
    const repos = new Map();
    for (const e of hit) repos.set(e.repo, (repos.get(e.repo) ?? 0) + 1);
    const detail = [...repos.entries()].sort((a, b) => b[1] - a[1] || byBytes(a[0], b[0])).map(([r, n]) => {
      // A head names its pull requests; a licence names the licence file.
      if (label.startsWith(HEAD_GONE)) return `${r} ${n} (${hit.filter((e) => e.repo === r).map((e) => prRef(e.prUrl).replace(/^.*#/, "#")).join(", ")})`;
      const l = entries.find((e) => e.repo === r).licence;
      return `${r} ${n}${l.spdx ? ` (${l.spdx}, ${l.file ?? "no file"})` : ""}`;
    });
    say(`  ${label}: ${plural(hit.length, "pull request")} in ${plural(repos.size, "repository", "repositories")}${detail.length ? `: ${detail.join(", ")}` : ""}`);
  }
  const unverified = usable.filter((e) => e.licence.class === "unverified");
  const unverifiedRepos = [...new Set(unverified.map((e) => e.repo))].map((r) => [r, unverified.filter((e) => e.repo === r).length]).sort((a, b) => b[1] - a[1] || byBytes(a[0], b[0]));
  say(`Usable with an unverified licence (GitHub names no licence it can classify; recorded as unverified, used and published in full like any other): ${plural(unverified.length, "pull request")} in ${plural(unverifiedRepos.length, "repository", "repositories")}${unverifiedRepos.length ? `: ${unverifiedRepos.map(([r, n]) => `${r} ${n} (${licenceNote(unverified.find((e) => e.repo === r).licence)})`).join(", ")}` : ""}`);
  say("Left out before the cases (not cases):");
  say(`  rejected comments of a pull request with no accepted comment: ${plural(negativeOnly.length, "pull request")}, ${plural(negativeOnly.reduce((n, x) => n + x.comments, 0), "rejected comment")}${negativeOnly.length ? `: ${negativeOnly.map((x) => `${x.ref} ${x.comments}`).join(", ")}` : ""}`);
  say(`  malformed or repeated rows: ${notCases.length}${notCases.length ? `: ${notCases.map((x) => `${x.ref} (${x.why})`).join("; ")}` : ""}`);
  const all = entries.flatMap((e) => {
    const r = rows.find((x) => x.githubPrUrl === e.prUrl && x.target_commit === e.headSha);
    const n = negByKey.get(rowKey(r));
    return [...r.comments.map((c) => ({ c, valid: true })), ...(n ? n.comments.map((c) => ({ c, valid: false })) : [])];
  });
  const reversed = all.filter((x) => x.c.from_line > x.c.to_line);
  const left = all.filter((x) => x.c.side === "left");
  const uncategorised = all.filter((x) => !Object.hasOwn(AACR_CATEGORIES, x.c.category));
  say(`Truth notes: ${plural(reversed.length, "comment")} with a reversed line range, kept as [low, high] with the raw range in meta; ${plural(left.filter((x) => x.valid).length, "accepted comment")} and ${plural(left.filter((x) => !x.valid).length, "rejected comment")} on the left side, tagged deletion; ${plural(uncategorised.length, "comment")} with a category outside AACR's four, given no category.`);
  say();
  say(`Reserved: ${plural(reservedGroups.length, "repository group")}, ${plural(split.counts.reserved, "pull request")}, to held-out before any group is hashed.`);
  for (const g of reservedGroups) {
    const why = (board) => g.reserved.filter((r) => r.board === board);
    const show = (list) => list.map((r) => (r.original ? `${prRef(r.prUrl)} (original ${r.original.replace("https://github.com/", "")})` : prRef(r.prUrl))).join(", ");
    say(`  ${g.group}: ${plural(g.names.length, "pull request")}; members ${membersOf.get(g.group).sort(byBytes).join(", ")}; Martian ${why("martian").length}${why("martian").length ? ` (${show(why("martian"))})` : ""}; ReviewBench ${why("reviewbench").length}${why("reviewbench").length ? ` (${show(why("reviewbench"))})` : ""}`);
  }
  const same = entries.filter((e) => reservedPrs.has(normPr(e.prUrl))).map((e) => `${prRef(e.prUrl)} (${reservedPrs.get(normPr(e.prUrl))})`);
  say(`  Same pull request in a reserved list: ${same.length ? same.join(", ") : "none"}`);
  const reposIn = (list) => new Set(list.map((u) => repoOfUrl(u)).filter(Boolean).map(key)).size;
  say(`  Martian: ${plural(martian.reservedPrUrls.length, "pull request")} in ${plural(reposIn(martian.reservedPrUrls), "repository", "repositories")}, ${plural(originals.length, "original")} named for its evaluation copies; reached ${plural(reached.martian.size, "group")}.`);
  say(`  ReviewBench: ${plural(reviewbench.reservedPrUrls.length, "pull request")} in ${plural(reposIn(reviewbench.reservedPrUrls), "repository", "repositories")}; reached ${plural(reached.reviewbench.size, "group")}.`);
  const unknownReserved = otherRepos.filter((r) => answers.get(key(r))?.found === false);
  say(`  Reserved-list repositories GitHub does not know (grouped by name only): ${unknownReserved.length}${unknownReserved.length ? `: ${unknownReserved.join(", ")}` : ""}`);
  say(`  Reserved-list links that are not pull request links: ${badLinks.length}${badLinks.length ? `: ${badLinks.map((b) => b.prUrl).join(", ")}` : ""}`);
  const joined = groupList.filter((g) => membersOf.get(g.group).length > 1 && !g.reserved);
  say(`  Other groups of more than one repository: ${joined.length ? joined.map((g) => `${g.group} (${membersOf.get(g.group).sort(byBytes).join(", ")})`).join("; ") : "none"}`);
  say();
  say(`Split ${SPLIT_NAME} (by repository group, within each language, dev ${SHARE.dev} and test ${SHARE.test}, salt ${SALT}), made from the ${splitPool.length} pull requests whose licence is usable (${splitPool.filter((e) => e.licence.class === "unverified").length} of them unverified):`);
  // Said only by the ingest that places them, so a later ingest of the same
  // pins writes the same report.
  const before = new Set([...(previousSplit?.cases?.dev ?? []), ...(previousSplit?.cases?.test ?? [])]);
  const added = { dev: dev.filter((n) => !before.has(n)).length, test: test.filter((n) => !before.has(n)).length };
  if (previousSplit && added.dev + added.test > 0) say(`  newly placed by the same rule: ${plural(added.dev + added.test, "pull request")}, ${added.dev} development and ${added.test} held-out; no case the earlier split placed moved, and the subsets are kept as it drew them`);
  say(`  development: ${plural(split.counts.groups.dev, "group")}, ${plural(dev.length, "pull request")} (${pct(dev.length, splitPool.length)}%)`);
  say(`  held-out: ${plural(split.counts.groups.test, "group")}, ${plural(test.length, "pull request")} (${pct(test.length, splitPool.length)}%): ${split.counts.reserved} reserved, ${test.length - split.counts.reserved} by hash`);
  const goneIn = (names) => names.filter((n) => entryOf.get(n).excludedWhy?.startsWith(HEAD_GONE));
  say(`  listed but excluded because the host no longer serves the head: ${goneIn(dev).length} development, ${goneIn(test).length} held-out, ${goneIn(laptop).length} of dev-laptop, ${goneIn(smoke).length} of dev-smoke`);
  say("  language      usable  dev  held-out  of which reserved");
  for (const l of perLanguage) say(`  ${l.language.padEnd(12)} ${String(l.total).padStart(7)} ${String(l.dev).padStart(4)} ${String(l.test).padStart(9)} ${String(l.reservedTest).padStart(18)}`);
  const ends = thirds.map((t) => (t.length ? entryOf.get(t.at(-1)).changeLines : null));
  const langCount = (list) => {
    const m = new Map();
    for (const n of list) m.set(languageOf(n), (m.get(languageOf(n)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => byBytes(a[0], b[0])).map(([l, n]) => `${l} ${n}`).join(", ");
  };
  if (previousSplit?.subsets?.["dev-laptop"]) say(`dev-laptop: ${plural(laptop.length, "pull request")}, kept as the earlier split file drew them; ${langCount(laptop)}`);
  else say(`dev-laptop: ${plural(laptop.length, "pull request")}, ${thirds.map((t) => t.filter((n) => laptop.includes(n)).length).join(", ")} from the three thirds by change size (the thirds end at ${ends.slice(0, 2).join(" and ")} changed lines); ${langCount(laptop)}`);
  say(`dev-smoke: ${plural(smoke.length, "pull request")}: ${smoke.map((n) => `${n} (${entryOf.get(n).changeLines} lines, ${languageOf(n)})`).join(", ")}`);
  say("No held-out pull request was materialised, reviewed or scored by this ingest.");
  const report = `${lines.join("\n")}\n`;

  const files = {
    [SUITES.aacr.cases]: `${JSON.stringify(suite, null, 2)}\n`,
    [SUITES.aacr.split]: `${JSON.stringify(split, null, 2)}\n`,
    "suites/aacr/ingest-report.txt": report,
  };
  return { suite, split, report, files };
}

// Writes the ingest's files under `root` (the benchmark folder). A split
// file that exists is only ever extended (lib/suites.mjs
// splitRewriteProblems): a moved or dropped case, or a changed subset, needs
// a new split, which is a new file; runs compare only within one split hash.
export function writeIngest(result, { root = benchRoot } = {}) {
  const splitPath = join(root, SUITES.aacr.split);
  const problems = existsSync(splitPath) ? splitRewriteProblems(JSON.parse(readFileSync(splitPath, "utf8")), JSON.parse(result.files[SUITES.aacr.split])) : [];
  if (problems.length > 0) {
    throw new Error(`${splitPath} exists, and a new split is a new file: write it as ${SPLIT_NAME.replace(/\d+$/, (n) => String(Number(n) + 1))} with its own salt, or move the old file to the Trash if no run has used it. The new split would change it:\n  ${problems.join("\n  ")}`);
  }
  const written = [];
  for (const [rel, text] of Object.entries(result.files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    written.push(path);
  }
  return written;
}

async function main(args) {
  const usage = "usage: node benchmark/ingest/aacr.mjs [--offline]\n       node benchmark/ingest/aacr.mjs --data-only\n       node benchmark/ingest/aacr.mjs --freeze-merge-base <name>";
  if (args[0] === "--freeze-merge-base") {
    if (args.length !== 2) {
      console.error(usage);
      return 2;
    }
    const r = freezeMergeBase("aacr", args[1]);
    if (r.frozen) console.log(`${r.name}: git finds ${r.bases.length} merge bases (${r.bases.join(", ")}); froze ${r.mergeBaseSha}, the first by the rule: ${r.rule}. ${r.from} is now ${r.to}.`);
    else console.log(`${r.name}: nothing frozen; ${r.mergeBaseSha ? `the entry already freezes ${r.mergeBaseSha}` : "git finds one merge base"}. The id stays ${r.from}.`);
    return 0;
  }
  const dataOnly = args.length === 1 && args[0] === "--data-only";
  const unknown = args.filter((a) => a !== "--offline");
  if (!dataOnly && unknown.length > 0) {
    console.error(usage);
    return 2;
  }
  const boards = JSON.parse(readFileSync(BOARDS_PATH, "utf8"));
  if (dataOnly) {
    for (const f of await fetchData({ boards })) console.log(`${f.path}: ${f.downloaded ? "downloaded and checked against its pin" : "in the cache, checked against its pin"}`);
    return 0;
  }
  const casesPath = join(benchRoot, SUITES.aacr.cases);
  const previous = existsSync(casesPath) ? JSON.parse(readFileSync(casesPath, "utf8")) : null;
  const splitPath = join(benchRoot, SUITES.aacr.split);
  const previousSplit = existsSync(splitPath) ? JSON.parse(readFileSync(splitPath, "utf8")) : null;
  const result = await ingestAacr({ boards, offline: args.includes("--offline"), previous, previousSplit, log: (s) => console.error(s) });
  writeIngest(result);
  process.stdout.write(result.report);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error.message);
      process.exitCode = 2;
    },
  );
}
