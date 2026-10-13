// The AACR-Bench ingest (benchmark/ingest/aacr.mjs), its licence check
// (lib/licence.mjs), the suite reader (lib/suites.mjs) and the split file.
// Every test runs the real ingest on a small dataset written here, in
// AACR-Bench's own row shape, with the pinned files and GitHub's answers
// placed in a temp cache, so nothing reaches the network but the one test
// that serves a file over a local HTTP server. Seven failures are guarded:
//
// 1. An upstream edit to the dataset changes the truth under a frozen id.
// 2. A pull request with no licence is used.
// 3. One repository group's pull requests land on both sides of the split.
// 4. A repository group holding a Martian or ReviewBench pull request lands
//    in development.
// 5. The laptop sample is the smallest changes.
// 6. A pull request whose head the host no longer serves (pushed over after
//    the dataset was made) is offered to a run, which then cannot fetch it.
// 7. A run's truth files are fetched by an ingest that also rewrites the
//    committed suite and asks GitHub about every repository (the weekly CI
//    job needs the two pinned data files and nothing else).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fetchData, ingestAacr, writeIngest } from "../ingest/aacr.mjs";
import { classify, saveCommitAnswer, saveRepoAnswer } from "../lib/licence.mjs";
import { listCases, readCase, truthOf } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const COMMIT = "a".repeat(40);
const POSITIVE = "dataset/positive_samples.json";
const NEGATIVE = "dataset/negative_samples.json";
const CATEGORIES = ["Code Defect", "Security Vulnerability", "Performance", "Maintainability and Readability"];

// [repository, language, pull requests, GitHub's licence id (null: no
// licence file), { fork: the repository GitHub names as its source,
// fullName: the name GitHub answers with after a rename }]
const REPOS = [
  ["acme/alpha", "Go", 8, "MIT"],
  ["bravo-org/bravo", "Go", 6, "Apache-2.0"],
  ["charlie/charlie", "Go", 5, "BSD-3-Clause"],
  ["delta/delta", "Go", 4, "MIT"],
  ["echo/echo", "Go", 3, "MIT"],
  ["upstream/widget", "Go", 3, "MIT"],
  ["forker/widget-plus", "Go", 2, "MIT", { fork: "upstream/widget" }],
  ["nolicence/none", "Go", 2, null],
  ["py/one", "Python", 7, "MIT"],
  ["py/two", "Python", 5, "Apache-2.0"],
  ["py/three", "Python", 4, "MIT"],
  ["py/four", "Python", 3, "ISC"],
  ["py/five", "Python", 3, "MIT"],
  ["one/shared", "Python", 2, "MIT"],
  ["two/shared", "Python", 2, "MIT"],
  ["sen/sentry", "Python", 3, "Apache-2.0"],
  ["fuzzy/assert", "Python", 2, "NOASSERTION"],
  ["jv/kilo", "Java", 6, "Apache-2.0"],
  ["jv/lima", "Java", 5, "MIT"],
  ["jv/mike", "Java", 4, "MIT"],
  ["jv/november", "Java", 3, "MIT"],
  ["old/renamed", "Java", 2, "MIT", { fullName: "new/renamed2" }],
  ["copyleft/gpl", "Java", 2, "GPL-3.0"],
  ["keyco/keyco", "Java", 4, "Apache-2.0"],
];

// Martian's golden files: one pull request of keyco/keyco itself, an
// evaluation copy whose original is AACR's keyco/keyco#2, and an
// evaluation copy of sen/sentry named only through a commit link.
const MARTIAN = {
  "offline/golden_comments/keyco.json": [
    { pr_title: "t", url: "https://github.com/keyco/keyco/pull/900", comments: [] },
    { pr_title: "t", url: "https://github.com/eval-org/keyco-greptile/pull/1", original_url: "https://github.com/keyco/keyco/pull/2", comments: [] },
  ],
  "offline/golden_comments/sentry.json": [{ pr_title: "t", url: "https://github.com/eval-org/sentry-copy/pull/2", original_url: "https://github.com/sen/sentry/commit/abcdef0", comments: [] }],
};
// ReviewBench: a copy of echo under another owner (grouped by name), the new
// name of a renamed AACR repository, and one that reaches nothing.
const REVIEWBENCH = ["https://github.com/copy/echo/pull/3", "https://github.com/new/renamed2/pull/9", "https://github.com/rb/unrelated/pull/1"];
// Repositories only the reserved lists name, with GitHub's answer.
const OTHERS = [
  ["eval-org/keyco-greptile", {}],
  ["eval-org/sentry-copy", {}],
  ["copy/echo", {}],
  ["new/renamed2", {}],
  ["rb/unrelated", { found: false }],
];

function dataset() {
  const positive = [];
  const negative = [];
  let i = 0;
  for (const [repo, language, count] of REPOS) {
    for (let pr = 1; pr <= count; pr++) {
      i++;
      const head = createHash("sha1").update(`head ${repo} ${pr}`).digest("hex");
      const base = createHash("sha1").update(`base ${repo} ${pr}`).digest("hex");
      const row = (comments) => ({ change_line_count: 3 + ((i * 53) % 600), project_main_language: language, source_commit: base, target_commit: head, githubPrUrl: `https://github.com/${repo}/pull/${pr}`, comments, category: "Bug Fix" });
      const comment = (n, side) => ({ is_ai_comment: n % 2 === 0, note: `Comment ${n} on ${repo}#${pr}: the loop reads past the end.`, path: `src/file${n}.go`, side, source_model: n % 2 === 0 ? "Model-X" : "", from_line: 10 + n, to_line: 12 + n, category: CATEGORIES[(i + n) % 4], context: "Diff Level" });
      positive.push(row([comment(1, "right"), comment(2, pr === 2 ? "left" : "right")]));
      if (pr === 1) negative.push(row([comment(9, "right")]));
    }
  }
  // Rejected comments for a pull request with no accepted comment: not a case.
  negative.push({ change_line_count: 10, project_main_language: "Go", source_commit: "b".repeat(40), target_commit: "c".repeat(40), githubPrUrl: "https://github.com/acme/alpha/pull/99", comments: [], category: "Bug Fix" });
  return { positive, negative };
}

const encode = (rows) => Buffer.from(`${JSON.stringify(rows, null, 2)}\n`);

// A cache holding the pinned files and every GitHub answer the ingest asks
// for, and the board pins that name them.
// `unserved` lists heads (<owner>/<name>#<number>) the host no longer serves.
function setup({ positive, negative } = dataset(), { url = (path) => `https://example.invalid/${path}`, seedRaw = true, unserved = [] } = {}) {
  const cache = tempDir("oq-ingest-cache-");
  const files = { aacr: { [POSITIVE]: encode(positive), [NEGATIVE]: encode(negative) }, martian: Object.fromEntries(Object.entries(MARTIAN).map(([p, rows]) => [p, encode(rows)])) };
  if (seedRaw) {
    for (const [board, byPath] of Object.entries(files)) {
      for (const [path, bytes] of Object.entries(byPath)) {
        mkdirSync(dirname(join(cache, "raw", board, path)), { recursive: true });
        writeFileSync(join(cache, "raw", board, path), bytes);
      }
    }
  }
  const pins = (board) => Object.entries(files[board]).map(([path, bytes]) => ({ path, url: url(path), sha256: sha256(bytes) }));
  const boards = {
    version: 1,
    boards: {
      aacr: { repo: "alibaba/aacr-bench", source: `https://github.com/alibaba/aacr-bench/tree/${COMMIT}`, commit: COMMIT, licence: "Apache-2.0", data: pins("aacr"), reservedPrUrls: [] },
      martian: { repo: "withmartian/code-review-benchmark", commit: "d".repeat(40), licence: "MIT", data: pins("martian"), reservedPrUrls: Object.values(MARTIAN).flat().map((r) => r.url) },
      reviewbench: { repo: "review-bench/ReviewBench", commit: "e".repeat(40), licence: "MIT", data: [], reservedPrUrls: REVIEWBENCH },
    },
  };
  for (const [repo, , , spdx, extra = {}] of REPOS) {
    const licence = spdx === null ? null : { spdx, key: spdx.toLowerCase(), file: "LICENSE", fileSha256: sha256(`licence of ${repo}`) };
    saveRepoAnswer(cache, { asked: repo, readOn: "2026-10-11", found: true, fullName: extra.fullName ?? repo, fork: Boolean(extra.fork), source: extra.fork ?? null, licence });
  }
  for (const [repo, extra] of OTHERS) saveRepoAnswer(cache, { asked: repo, readOn: "2026-10-11", found: extra.found ?? true, fullName: extra.found === false ? null : repo, fork: false, source: null });
  for (const r of positive) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(r.githubPrUrl);
    saveCommitAnswer(cache, { repo: m[1], sha: r.target_commit, readOn: "2026-10-11", served: !unserved.includes(`${m[1]}#${m[2]}`) });
  }
  return { cache, boards, files };
}

// Ingests into a fresh benchmark root and returns everything it wrote.
async function ingestInto(ctx, root = tempDir("oq-ingest-root-")) {
  const result = await ingestAacr({ boards: ctx.boards, cache: ctx.cache, offline: true });
  writeIngest(result, { root });
  const cases = JSON.parse(readFileSync(join(root, "suites/aacr/cases.json"), "utf8"));
  const split = JSON.parse(readFileSync(join(root, "splits/aacr-v1.json"), "utf8"));
  const report = readFileSync(join(root, "suites/aacr/ingest-report.txt"), "utf8");
  return { root, result, cases, split, report };
}

const repoOf = (name) => name.replace(/-\d+$/, "").replace("__", "/");
const sideOf = (split, name) => (split.cases.dev.includes(name) ? "dev" : split.cases.test.includes(name) ? "test" : null);

describe("an upstream edit to the dataset changes the truth under a frozen id", () => {
  it("refuses a cached data file that differs from its pin, in the ingest and when the truth is read", async () => {
    const ctx = setup();
    const { root } = await ingestInto(ctx);
    const id = listCases({ suite: "aacr", root }).find((x) => x.startsWith("aacr/acme__alpha-1@"));
    const c = readCase(id, { root });
    expect(truthOf(c, { cache: ctx.cache }).items.map((t) => t.id)).toEqual(["c1", "c2", "r1"]);

    const path = join(ctx.cache, "raw", "aacr", POSITIVE);
    writeFileSync(path, readFileSync(path, "utf8").replace("Comment 1 on acme/alpha#1", "Comment 1 on acme/alpha#1, edited"));
    await expect(ingestAacr({ boards: ctx.boards, cache: ctx.cache, offline: true })).rejects.toThrow(/positive_samples\.json.*sha256.*pinned/s);
    expect(() => truthOf(c, { cache: ctx.cache })).toThrow(/positive_samples\.json.*sha256.*pinned/s);
  });

  it("refuses a download that differs from its pin and keeps nothing of it", async () => {
    const { positive, negative } = dataset();
    const edited = structuredClone(positive);
    edited[0].comments[0].note = "An edited note.";
    const served = { [`/${POSITIVE}`]: encode(edited), [`/${NEGATIVE}`]: encode(negative) };
    const server = createServer((req, res) => {
      const body = served[req.url];
      res.statusCode = body ? 200 : 404;
      res.end(body ?? "not found");
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const port = server.address().port;
      const ctx = setup({ positive, negative }, { url: (path) => `http://127.0.0.1:${port}/${path}`, seedRaw: false });
      await expect(ingestAacr({ boards: ctx.boards, cache: ctx.cache })).rejects.toThrow(/positive_samples\.json.*sha256.*pinned/s);
      expect(existsSync(join(ctx.cache, "raw", "aacr", POSITIVE))).toBe(false);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("gives the edited pull request a new id once the new file is pinned, and leaves every other id alone", async () => {
    const before = await ingestInto(setup());
    const { positive, negative } = dataset();
    positive[0].comments[0].note = "An edited note.";
    const after = await ingestInto(setup({ positive, negative }));
    const ids = (r) => Object.fromEntries(listCases({ suite: "aacr", root: r.root }).map((id) => [id.split("@")[0], id]));
    const [a, b] = [ids(before), ids(after)];
    expect(Object.keys(a)).toEqual(Object.keys(b));
    for (const name of Object.keys(a)) {
      if (name === "aacr/acme__alpha-1") expect(b[name]).not.toBe(a[name]);
      else expect(b[name]).toBe(a[name]);
    }
    expect(() => readCase(a["aacr/acme__alpha-1"], { root: after.root })).toThrow(/new case/);
  });

  it("commits no comment text, only its hash", async () => {
    const { root } = await ingestInto(setup());
    for (const file of ["suites/aacr/cases.json", "splits/aacr-v1.json", "suites/aacr/ingest-report.txt"]) {
      expect(readFileSync(join(root, file), "utf8")).not.toMatch(/the loop reads past the end/);
    }
  });

  it("writes byte-identical files on a second ingest, and never rewrites a split file with other content", async () => {
    const ctx = setup();
    const first = await ingestInto(ctx);
    const second = await ingestInto(ctx);
    for (const file of ["suites/aacr/cases.json", "splits/aacr-v1.json", "suites/aacr/ingest-report.txt"]) {
      expect(readFileSync(join(second.root, file))).toEqual(readFileSync(join(first.root, file)));
    }
    ctx.boards.boards.reviewbench.reservedPrUrls = [...REVIEWBENCH, "https://github.com/py/one/pull/77"];
    const moved = await ingestAacr({ boards: ctx.boards, cache: ctx.cache, offline: true });
    expect(() => writeIngest(moved, { root: first.root })).toThrow(/a new split is a new file/);
    expect(readFileSync(join(first.root, "splits/aacr-v1.json"))).toEqual(readFileSync(join(second.root, "splits/aacr-v1.json")));
  });
});

describe("a pull request with no licence is used", () => {
  it("excludes a repository with no licence file, records a licence GitHub cannot name as unverified, and reports both with counts", async () => {
    const { root, cases, split, report } = await ingestInto(setup());
    const byName = Object.fromEntries(cases.cases.map((e) => [e.name, e]));
    expect(byName["nolicence__none-1"]).toMatchObject({ status: "excluded", licence: { class: "none" } });
    expect(byName["nolicence__none-1"].excludedWhy).toMatch(/no licence/);
    expect(byName["fuzzy__assert-1"]).toMatchObject({ status: "usable", excludedWhy: null, licence: { class: "unverified", spdx: "NOASSERTION", excerpts: "omit" } });
    const usable = listCases({ suite: "aacr", root });
    for (const id of usable) expect(id).not.toMatch(/nolicence__none/);
    expect(usable.filter((id) => /fuzzy__assert/.test(id))).toHaveLength(2);
    for (const name of [...split.cases.dev, ...split.cases.test]) expect(name).not.toMatch(/nolicence__none/);
    expect(report).toMatch(/licence none[^\n]*: 2 pull requests/);
    expect(report).toMatch(/nolicence\/none 2/);
    expect(report).toMatch(/unverified licence[^\n]*: 2 pull requests[^\n]*fuzzy\/assert 2 \(NOASSERTION/);
    expect(report).not.toMatch(/licence unknown/);
  });

  it("gives every usable case a licence class, a repository group and a split", async () => {
    const { root } = await ingestInto(setup());
    const ids = listCases({ suite: "aacr", root });
    expect(ids.length).toBe(88);
    for (const id of ids) {
      const c = readCase(id, { root });
      expect(["permissive", "copyleft", "source-available", "unverified"]).toContain(c.source.licence.class);
      expect(c.repoGroup).toMatch(/\//);
      expect(["dev", "test"]).toContain(c.split);
      expect(c.origin).toBe("real");
    }
    expect(readCase(ids.find((x) => x.includes("copyleft__gpl")), { root }).source.licence).toMatchObject({ class: "copyleft", excerpts: "omit" });
  });

  it("classes licence ids, taking the open option of an OR expression", () => {
    expect(classify("MIT")).toEqual({ chosen: "MIT", class: "permissive" });
    expect(classify("AGPL-3.0")).toEqual({ chosen: "AGPL-3.0", class: "copyleft" });
    expect(classify("Elastic-2.0")).toEqual({ chosen: "Elastic-2.0", class: "source-available" });
    expect(classify("SSPL-1.0 OR Elastic-2.0 OR AGPL-3.0-only")).toEqual({ chosen: "AGPL-3.0-only", class: "copyleft" });
    expect(classify("NOASSERTION")).toEqual({ chosen: null, class: "unverified" });
    expect(classify("WTFPL")).toEqual({ chosen: null, class: "unverified" });
    expect(classify(null)).toEqual({ chosen: null, class: "none" });
  });
});

describe("a pull request whose head the host no longer serves is offered to a run", () => {
  it("excludes it with the reason, the way a licence exclusion is recorded, with its id and the split unchanged", async () => {
    const before = await ingestInto(setup());
    const gone = ["acme__alpha-3", "py__one-2"];
    const after = await ingestInto(setup(dataset(), { unserved: ["acme/alpha#3", "py/one#2"] }));
    const at = (r, name) => r.cases.cases.find((e) => e.name === name);
    for (const name of gone) {
      expect(at(after, name)).toMatchObject({ status: "excluded", id: at(before, name).id, hash: at(before, name).hash });
      expect(at(after, name).excludedWhy).toMatch(/^head no longer served by the host: /);
      expect(listCases({ suite: "aacr", root: after.root }).some((id) => id.startsWith(`aacr/${name}@`))).toBe(false);
    }
    expect(listCases({ suite: "aacr", root: after.root }).length).toBe(listCases({ suite: "aacr", root: before.root }).length - 2);
    for (const e of after.cases.cases.filter((x) => !gone.includes(x.name))) expect(e).toEqual(at(before, e.name));
    expect(readFileSync(join(after.root, "splits/aacr-v1.json"), "utf8")).toBe(readFileSync(join(before.root, "splits/aacr-v1.json"), "utf8"));
    expect(after.report).toMatch(/head no longer served by the host[^\n]*: 2 pull requests in 2 repositories: acme\/alpha 1 \(#3\), py\/one 1 \(#2\)/);
  });

  it("stops offline when the host was never asked about a head, rather than using the case", async () => {
    const ctx = setup();
    const r = dataset().positive[0];
    const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(r.githubPrUrl)[1];
    renameSync(join(ctx.cache, "github", "commits", repo.toLowerCase().replace("/", "__"), `${r.target_commit}.json`), join(ctx.cache, "moved-away.json"));
    await expect(ingestAacr({ boards: ctx.boards, cache: ctx.cache, offline: true })).rejects.toThrow(/no cached GitHub answer for acme\/alpha commit/);
  });
});

describe("a pull request that becomes usable moves a case the split already placed, or changes an id", () => {
  // fuzzy/assert first answers with no licence file, then with a licence
  // GitHub cannot name, which is used and published in full.
  const answer = (ctx, licence) => saveRepoAnswer(ctx.cache, { asked: "fuzzy/assert", readOn: "2026-10-11", found: true, fullName: "fuzzy/assert", fork: false, source: null, licence });

  it("places only the newly usable pull requests, by the same group rule, and keeps every id, side and subset", async () => {
    const ctx = setup();
    answer(ctx, null);
    const first = await ingestInto(ctx);
    expect(first.cases.cases.filter((e) => e.repo === "fuzzy/assert").map((e) => e.status)).toEqual(["excluded", "excluded"]);
    answer(ctx, { spdx: "NOASSERTION", key: "other", file: "LICENSE", fileSha256: sha256("licence of fuzzy/assert") });
    const result = await ingestAacr({ boards: ctx.boards, cache: ctx.cache, offline: true, previous: first.cases, previousSplit: first.split });
    writeIngest(result, { root: first.root });
    const split = JSON.parse(readFileSync(join(first.root, "splits/aacr-v1.json"), "utf8"));
    for (const side of ["dev", "test"]) for (const name of first.split.cases[side]) expect(sideOf(split, name), name).toBe(side);
    expect(split.subsets).toEqual(first.split.subsets);
    for (const e of first.cases.cases) expect(result.suite.cases.find((x) => x.name === e.name).id).toBe(e.id);
    const placed = ["fuzzy__assert-1", "fuzzy__assert-2"];
    const group = split.groups.find((g) => g.members.includes("fuzzy/assert"));
    for (const name of placed) expect(sideOf(split, name), name).toBe(group.split);
    expect(split.cases.dev.length + split.cases.test.length).toBe(first.split.cases.dev.length + first.split.cases.test.length + 2);
    expect(result.report).toMatch(new RegExp(`newly placed by the same rule: 2 pull requests, ${group.split === "dev" ? 2 : 0} development and ${group.split === "test" ? 2 : 0} held-out; no case the earlier split placed moved`));
  });

  it("refuses a split that moves a case an earlier split placed, naming it, and a reservation that reaches a group placed in development", async () => {
    const ctx = setup();
    const first = await ingestInto(ctx);
    const result = await ingestAacr({ boards: ctx.boards, cache: ctx.cache, offline: true, previous: first.cases, previousSplit: first.split });
    const moved = first.split.cases.dev[0];
    const edited = JSON.parse(result.files["splits/aacr-v1.json"]);
    edited.cases = { dev: edited.cases.dev.filter((n) => n !== moved), test: [...edited.cases.test, moved].sort() };
    expect(() => writeIngest({ ...result, files: { ...result.files, "splits/aacr-v1.json": `${JSON.stringify(edited, null, 2)}\n` } }, { root: first.root })).toThrow(new RegExp(`a new split is a new file[\\s\\S]*${moved}`));

    ctx.boards.boards.reviewbench.reservedPrUrls = [...REVIEWBENCH, "https://github.com/py/one/pull/77"];
    await expect(ingestAacr({ boards: ctx.boards, cache: ctx.cache, offline: true, previous: first.cases, previousSplit: first.split })).rejects.toThrow(/py\/one[^\n]*development[^\n]*a new split is a new file/);
  });
});

describe("one repository group's pull requests land on both sides of the split", () => {
  it("puts every group on one side, with forks, renames and same-named repositories grouped", async () => {
    const { split, cases } = await ingestInto(setup());
    const groupOf = new Map();
    for (const g of split.groups) for (const m of g.members) groupOf.set(m, g);
    expect(groupOf.get("forker/widget-plus")).toBe(groupOf.get("upstream/widget"));
    expect(groupOf.get("one/shared")).toBe(groupOf.get("two/shared"));
    expect(groupOf.get("old/renamed").members).toContain("new/renamed2");
    for (const g of split.groups) {
      const sides = new Set(cases.cases.filter((e) => e.status === "usable" && g.members.includes(e.repo.toLowerCase())).map((e) => sideOf(split, e.name)));
      expect(sides.size, g.group).toBe(1);
      expect([...sides][0]).toBe(g.split);
    }
    for (const e of cases.cases.filter((x) => x.status === "usable")) expect(sideOf(split, e.name), e.name).toBe(groupOf.get(e.repo.toLowerCase()).split);
    // About 80/20 by pull request count, and no language pushed far past
    // 20% held-out by its hashed groups.
    const test = split.cases.test.length / (split.cases.dev.length + split.cases.test.length);
    expect(test).toBeGreaterThan(0.15);
    expect(test).toBeLessThan(0.25);
    for (const language of ["Go", "Java", "Python"]) {
      const of = split.groups.filter((g) => g.language === language);
      const total = of.reduce((n, g) => n + g.prs, 0);
      const reserved = of.filter((g) => g.reserved).reduce((n, g) => n + g.prs, 0);
      const hashed = of.filter((g) => !g.reserved && g.split === "test").reduce((n, g) => n + g.prs, 0);
      expect(reserved + hashed > 0.2 * total + 0.5 ? hashed : 0, language).toBe(0);
    }
  });
});

describe("a repository group holding a Martian or ReviewBench pull request lands in development", () => {
  it("reserves every such group to held-out first and names why", async () => {
    const { split, report } = await ingestInto(setup());
    const group = (repo) => split.groups.find((g) => g.members.includes(repo));
    for (const [repo, board] of [["keyco/keyco", "martian"], ["sen/sentry", "martian"], ["echo/echo", "reviewbench"], ["old/renamed", "reviewbench"]]) {
      const g = group(repo);
      expect(g.split, repo).toBe("test");
      expect(g.reserved.map((r) => r.board), repo).toContain(board);
      for (const name of [...split.cases.dev, ...split.cases.test].filter((n) => repoOf(n) === repo)) expect(sideOf(split, name)).toBe("test");
    }
    expect(group("py/one").reserved).toBeNull();
    expect(report).toMatch(/keyco\/keyco: 4 pull requests/);
    expect(report).toMatch(/same pull request[^\n]*keyco\/keyco#2/i);
    expect(report).toMatch(/Reserved: 4 repository groups, 12 pull requests/);
  });
});

describe("the laptop sample is the smallest changes", () => {
  it("takes 36 development pull requests, 12 from each change-size tercile, spread over languages", async () => {
    const { root, split, cases } = await ingestInto(setup());
    const size = Object.fromEntries(cases.cases.map((e) => [e.name, e.changeLines]));
    const language = Object.fromEntries(cases.cases.map((e) => [e.name, e.language]));
    const dev = [...split.cases.dev].sort((a, b) => size[a] - size[b] || (a < b ? -1 : 1));
    const laptop = split.subsets["dev-laptop"];
    expect(laptop).toHaveLength(36);
    for (const name of laptop) expect(split.cases.dev).toContain(name);
    const third = (k) => dev.slice(Math.floor((dev.length * k) / 3), Math.floor((dev.length * (k + 1)) / 3));
    for (let k = 0; k < 3; k++) {
      const picked = third(k).filter((n) => laptop.includes(n));
      expect(picked, `tercile ${k + 1}`).toHaveLength(12);
      expect(new Set(picked.map((n) => language[n])).size, `tercile ${k + 1}`).toBe(3);
    }
    expect(laptop.slice().sort()).not.toEqual(dev.slice(0, 36).sort());
    expect(listCases({ suite: "aacr", subset: "dev-laptop", root })).toHaveLength(36);

    const smoke = split.subsets["dev-smoke"];
    expect(smoke).toHaveLength(5);
    for (const name of smoke) expect(split.cases.dev).toContain(name);
  });
});

describe("a run's truth files are fetched by an ingest that also rewrites the committed suite and asks GitHub", () => {
  // Serves the two pinned files, counting the requests.
  async function serve(files) {
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url);
      const body = files[req.url.slice(1)];
      res.statusCode = body ? 200 : 404;
      res.end(body ?? "not found");
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    return { hits, port: server.address().port, close: () => new Promise((done) => server.close(done)) };
  }
  const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort() : []);
  const boardsFor = (pins) => ({ version: 1, boards: { aacr: { repo: "alibaba/aacr-bench", commit: COMMIT, licence: "Apache-2.0", data: pins, reservedPrUrls: [] } } });

  it("puts exactly the two pinned AACR files in the cache, asks nothing else, and downloads nothing on a second call", async () => {
    const { positive, negative } = dataset();
    const bytes = { [POSITIVE]: encode(positive), [NEGATIVE]: encode(negative) };
    const http = await serve(bytes);
    try {
      const cache = tempDir("oq-ingest-data-");
      const boards = boardsFor(Object.entries(bytes).map(([path, b]) => ({ path, url: `http://127.0.0.1:${http.port}/${path}`, sha256: sha256(b) })));
      expect(await fetchData({ boards, cache })).toEqual([{ path: POSITIVE, downloaded: true }, { path: NEGATIVE, downloaded: true }]);
      expect(filesUnder(cache)).toEqual([join("raw", "aacr", NEGATIVE), join("raw", "aacr", POSITIVE)]);
      expect([...http.hits].sort()).toEqual([`/${NEGATIVE}`, `/${POSITIVE}`]);
      expect(await fetchData({ boards, cache })).toEqual([{ path: POSITIVE, downloaded: false }, { path: NEGATIVE, downloaded: false }]);
      expect(http.hits).toHaveLength(2);
    } finally {
      await http.close();
    }
  });

  it("refuses a served file that differs from its pin and keeps nothing of it", async () => {
    const { positive, negative } = dataset();
    const http = await serve({ [POSITIVE]: encode([...positive].reverse()), [NEGATIVE]: encode(negative) });
    try {
      const cache = tempDir("oq-ingest-data-");
      const boards = boardsFor([POSITIVE, NEGATIVE].map((path) => ({ path, url: `http://127.0.0.1:${http.port}/${path}`, sha256: sha256(encode(path === POSITIVE ? positive : negative)) })));
      await expect(fetchData({ boards, cache })).rejects.toThrow(/positive_samples\.json.*sha256.*pinned/s);
      expect(filesUnder(cache)).toEqual([]);
    } finally {
      await http.close();
    }
  });
});
