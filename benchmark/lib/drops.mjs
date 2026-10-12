// Classes every scanner candidate the reviewer dropped, from saved files
// only, so the scanner loop can see which fix a drop points at (the
// benchmark plan, part P2 4.4). Nothing here reads a file or starts a
// process; benchmark/drops.mjs does the reading.
//
// The first rule that holds decides, and structure is checked before words:
// the candidate's rule, its path, the ids and lines it cites, then the
// reason's words.
//   1. config-owned   the candidate is a settings-file or suppression-added
//                     candidate the scan raised itself, or the reason starts
//                     with "repo instructions:" (tagged repo-instructions).
//                     Points at nothing, unless all of at least 20 are
//                     dropped; then that candidate's severity changes.
//   2. fixture        the product's own fixture filter (isFixturePath)
//                     matches the path, or the reason calls the value
//                     fixture, sample or example data, a mock, a
//                     placeholder, a dummy or a fake value. Points at a
//                     missing fixture pattern.
//   3. test           a test path, or the reason speaks of a test file,
//                     code, suite, helper or an assert. Points at that rule's
//                     adapter (skip it in test paths); never a blanket test
//                     filter, since the scan keeps test files on purpose.
//   4. duplicate      the reason names another candidate (c and a number),
//                     or it cites a line outside the candidate's own lines
//                     where a raised candidate sits, or the reason says the
//                     candidate repeats, duplicates, is already raised,
//                     covered or reported, is covered by, covers, or is the
//                     same issue, problem or finding. Points at dedup.
//   5. out-of-change  the reason says the code is not part of the change.
//                     Points at the changed-line filter (wide spans).
//   6. low-value      style, a nitpick, a preference, size or enlarge,
//                     cosmetic, hygiene, harmless, no (behavioural,
//                     functional, security, runtime ...) impact or effect,
//                     little value. Points at the rule's default or its
//                     severity.
//   7. rule-fp        everything else: the rule was wrong here. Points at the
//                     rule (off by default when one rule holds many).
// Any class is tagged framework-mismatch when the reason names a framework
// the scan can detect and found in no project of the change; the tag points
// at gating the rule by framework.
//
// Failure list, written before the code:
// 1. A drop that says which candidate it repeats falls through to rule-fp,
//    so dedup work reads as wrong rules: ids are read before any word, and
//    a citation that points at a raised candidate's line counts with no
//    words at all.
// 2. A reason that quotes its own id ("c3 fires on ...") reads as a repeat:
//    only another candidate's id counts.
// 3. A drop in a test file is called a fixture, which points at the fixture
//    filter the scan deliberately does not apply to tests: only the
//    product's own isFixturePath, or fixture words, make a fixture.
// 4. A suppression candidate whose reason names the finding it hides is
//    classed a duplicate: the candidate's own rule is read first.
// 5. A framework the project does use is called a mismatch: the tag needs
//    a framework the scan can detect and found in no project. A framework
//    the scan cannot detect (SQLAlchemy), Flask (detected only by newer
//    scans, and never tagged: NEVER_TAGGED), and an older scan that
//    recorded no projects, give no tag rather than a guess.
// 6. A framework rule dropped as a repeat hides that it fired on the wrong
//    framework: the tag is read from the reason whatever the class.
// 7. A drop that cites its own line is called a repeat because a raised
//    candidate of another problem shares that line (one apt-get line holds
//    several hadolint rules): only a citation away from its own lines is
//    structure; on its own line the words decide.
// 8. A word inside another word decides a class ("sizeable", "outsized",
//    "covers" in "discovers"): every word is matched at word bounds.
// 8a. A path the reason quotes decides a class (app/c5.py names "c5",
//    app/fixtures.py says "fixtures"): words and ids are read with the
//    quoted paths taken out.
// 8b. A folder named like a test file (src/openapi.spec.v3/) makes its
//    files tests: .test. and .spec. count only in the file's own name.
// 9. An audit sheet that names the run, the build, the configuration or the
//    case lets the person rule on what they expect, not what they read:
//    the sheet shows only the rule, the place, the reason and the class,
//    and one redactor takes every known identifier out of every field of
//    both formats, a reason that quotes one included.
// 10. An audit that cannot be drawn again rules on a sample nobody can
//    check: the draw is seeded and depends on nothing but the seed and the
//    order of the drops.
import { isFixturePath } from "../../packages/scanners/dist/index.js";
import { normPath } from "./score.mjs";

export const DROPS_VERSION = 1;
export const DROP_CLASSES = Object.freeze(["config-owned", "fixture", "test", "duplicate", "out-of-change", "low-value", "rule-fp"]);
// What each class points at, printed beside its count.
export const POINTS_AT = Object.freeze({
  "config-owned": "nothing, unless all of at least 20 drop: then that candidate's severity",
  fixture: "a missing fixture pattern in the filter",
  test: "the rule's adapter: skip it in test paths",
  duplicate: "dedup: a same-problem group, the span rule, or merging inside an adapter",
  "out-of-change": "the changed-line filter: an anchor rule for wide spans",
  "low-value": "the rule's default or its severity mapping",
  "rule-fp": "the rule: off by default when one rule holds many",
});
// What each tag points at, whatever the class.
export const TAG_POINTS_AT = Object.freeze({ "framework-mismatch": "gating the rule by framework", "repo-instructions": "nothing: the repo put it out of scope" });

// The candidates the scan raises about the repo's own settings and new
// suppression comments (packages/core/src/finalize.ts SETTINGS_RULE and
// SUPPRESSION_RULE).
const CONFIG_RULES = new Set(["settings-file", "openqodex.suppression-added"]);
const REPO_INSTRUCTIONS = /^\s*repo instructions:/i;

const FIXTURE_WORDS = /\bfixtures?\b|\b(?:sample|example) data\b|\bmock(?:s|ed)?\b|\bplaceholders?\b|\bdumm(?:y|ies)\b|\bfake values?\b/i;

// The test paths: a tests or test folder, a spec or __tests__
// folder, .test. and .spec. files, Go's _test.go, Python's test_*.py and
// Ruby's *_spec.rb.
// A .test. or .spec. name counts only in the file's own name, never in a
// folder's (src/openapi.spec.v3/client.js is not a test).
const TEST_PATHS = [/(?:^|\/)tests?\//i, /(?:^|\/)spec\//i, /(?:^|\/)__tests__\//i, /(?:^|\/)[^/]*\.test\.[^/]*$/i, /(?:^|\/)[^/]*\.spec\.[^/]*$/i, /_test\.go$/i, /(?:^|\/)test_[^/]*\.py$/i, /_spec\.rb$/i];
const TEST_WORDS = /\btests? (?:file|code|suite|helper)s?\b|\bassert(?:s|ion|ions)?\b/i;

const CANDIDATE_ID = /\bc(\d+)\b/gi;
const DUPLICATE_WORDS = /\brepeat(?:s|ed|ing)?\b|\bduplicat(?:e|es|ed|ing|ion)\b|\balready (?:raised|covered|reported)\b|\bcovered by\b|\bcovers\b|\bsame (?:issue|problem|finding)s?\b/i;

const OUT_OF_CHANGE_WORDS = /\bnot changed\b|\bnot part of (?:this|the) change\b|\bpre-?existing\b|\bunchanged\b|\buntouched\b|\bexisted before\b|\boutside (?:of )?(?:this|the) change\b/i;

// "No ... impact" takes up to two words between ("no behavioural impact",
// "no realistic runtime impact"); hygiene is said of style, enlarge of size.
const LOW_VALUE_WORDS = /\bstyle\b|\bnitpicks?\b|\bpreferences?\b|\bsize\b|\benlarge[sd]?\b|\bcosmetic\b|\bhygiene\b|\bharmless\b|\bno (?:[a-z]+ ){0,2}(?:impact|effect)s?\b|\blittle value\b/i;

// The frameworks the scan can detect (the Framework type in
// packages/scanners/src/detect.ts), each with how a reason writes it. Only
// these can be missing from scan.projects: a framework the scan cannot
// detect, such as SQLAlchemy, is never known to be absent. Names that are
// also everyday words are matched only as capitalised names. Flask is
// detected but never tagged (NEVER_TAGGED).
const FRAMEWORKS = [
  ["django", /\bdjango\b/i],
  ["fastapi", /\bfastapi\b/i],
  ["airflow", /\bairflow\b/i],
  ["nextjs", /\bnext\.?js\b/i],
  ["react-native", /\bReact Native\b|\breact-native\b/],
  ["react", /\bReact\b(?! Native)/],
  ["rails", /\bRails\b/],
];
export const DETECTED_FRAMEWORKS = Object.freeze(FRAMEWORKS.map(([slug]) => slug));
// Frameworks the scan detects that a tag never names: scans saved before
// Flask was detected record a Flask project with no framework, and nothing in
// a scan tells those apart from newer ones, so Flask's absence from
// scan.projects says nothing.
export const NEVER_TAGGED = Object.freeze(["flask"]);

// Paths a reason quotes: any token with a slash, and a bare file name that
// starts in lower case with a known extension (a capitalised name such as
// Next.js is a name, not a file). Words and ids are read with these taken
// out, so app/c5.py names no candidate and app/fixtures.py is no fixture.
const PATH_TOKENS = /[^\s"'`()<>,;]*[/\\][^\s"'`()<>,;]*|(?<![\w.-])[a-z0-9_][\w.-]*\.(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|rb|go|rs|java|kt|kts|php|cs|c|h|cc|cpp|hpp|swift|scala|sh|bash|zsh|sql|tf|tfvars|hcl|yaml|yml|json|toml|lock|ini|cfg|conf|env|xml|html?|css|scss|md|txt|gradle|properties)\b/g;
export const withoutPaths = (reason) => String(reason ?? "").replace(PATH_TOKENS, " ");

const testPath = (path) => TEST_PATHS.some((re) => re.test(path));
const hit = (re, text) => {
  const m = re.exec(text);
  return m === null ? null : m[0];
};

// The frameworks the scan found across the change's projects, or null when
// the scan recorded none (an older scan.json): then no drop is tagged.
export function projectFrameworks(scan) {
  if (!Array.isArray(scan?.projects)) return null;
  return [...new Set(scan.projects.flatMap((p) => p.frameworks ?? []))].sort();
}

// The lines of every candidate the reviewer raised: a finding that names
// its candidate, on or off the change, at the candidate's own place (the
// finding's when the scan is missing).
export function raisedSpans(report, scan) {
  const byId = new Map((scan?.candidates ?? []).map((c) => [c.id, c]));
  const out = [];
  for (const f of [...(report?.findings ?? []), ...(report?.outside_change ?? [])]) {
    if (typeof f.candidate !== "string" || f.candidate === "") continue;
    const c = byId.get(f.candidate);
    const file = normPath(c ? c.filePath : f.file_path);
    const start = c ? c.lineStart : f.line_number;
    const end = Math.max(c ? c.lineEnd ?? start : f.line_end ?? start, start);
    out.push({ id: f.candidate, file, start, end });
  }
  return out;
}

// One drop's class: { class, tags, matched: { rule, text } }. `matched`
// names the rule that decided and the text it matched, so a person can see
// why. Context: the raised candidates' spans and the scan's frameworks.
export function classifyDrop(drop, { raised = [], frameworks = null } = {}) {
  const out = classOf(drop, raised);
  // The tag is the reason's, whatever the class: a framework rule dropped as
  // a repeat still fired on a framework the change does not use.
  const present = new Set(frameworks ?? []);
  const words = withoutPaths(drop?.reason);
  if (frameworks !== null && FRAMEWORKS.some(([slug, re]) => !present.has(slug) && re.test(words))) out.tags.push("framework-mismatch");
  return out;
}

function classOf(drop, raised) {
  const c = drop?.candidate ?? {};
  const raw = String(drop?.reason ?? "");
  // Every rule below reads the reason's words, never the paths it quotes.
  const reason = withoutPaths(raw);
  const file = normPath(c.filePath);
  const own = String(c.id ?? "").toLowerCase();
  const decide = (cls, rule, text = null, tags = []) => ({ class: cls, tags, matched: { rule, text } });

  if (CONFIG_RULES.has(c.ruleId)) return decide("config-owned", "config-rule", c.ruleId);
  if (REPO_INSTRUCTIONS.test(raw)) return decide("config-owned", "repo-instructions", "repo instructions:", ["repo-instructions"]);

  if (file !== "" && isFixturePath(file)) return decide("fixture", "fixture-path", file);
  const fixtureWord = hit(FIXTURE_WORDS, reason);
  if (fixtureWord) return decide("fixture", "fixture-words", fixtureWord);

  if (testPath(file)) return decide("test", "test-path", file);
  const testWord = hit(TEST_WORDS, reason);
  if (testWord) return decide("test", "test-words", testWord);

  const other = [...reason.matchAll(CANDIDATE_ID)].map((m) => m[0].toLowerCase()).find((id) => id !== own);
  if (other) return decide("duplicate", "names-candidate", other);
  // A citation is evidence of a repeat only when it points away from the
  // candidate's own lines to a raised candidate's: citing its own line, which
  // a raised candidate shares, says nothing about that one.
  const cited = drop?.cited;
  if (cited && typeof cited.line_number === "number") {
    const at = normPath(cited.file_path);
    const ownLine = at === file && c.lineStart <= cited.line_number && cited.line_number <= Math.max(c.lineEnd ?? c.lineStart, c.lineStart);
    const on = ownLine ? null : raised.find((r) => r.id !== c.id && r.file === at && r.start <= cited.line_number && cited.line_number <= r.end);
    if (on) return decide("duplicate", "cited-raised-line", `${at}:${cited.line_number} (${on.id})`);
  }
  const dupWord = hit(DUPLICATE_WORDS, reason);
  if (dupWord) return decide("duplicate", "duplicate-words", dupWord);

  const outWord = hit(OUT_OF_CHANGE_WORDS, reason);
  if (outWord) return decide("out-of-change", "out-of-change-words", outWord);

  const lowWord = hit(LOW_VALUE_WORDS, reason);
  if (lowWord) return decide("low-value", "low-value-words", lowWord);

  return decide("rule-fp", "fall-through");
}

// Every drop of one saved review, in its order, with its class. `report` is
// report.json, `scan` is scan.json (null when the sample has none).
export function classifyReportDrops(report, scan) {
  const context = { raised: raisedSpans(report, scan), frameworks: projectFrameworks(scan) };
  return (report?.dropped ?? []).map((d) => ({ candidate: d.candidate, reason: d.reason, cited: d.cited ?? null, ...classifyDrop(d, context) }));
}

// Counts by class (every class listed, zero or not), by tag, and the
// rule-fp drops by rule token, most first.
export function countDrops(classified) {
  const byClass = Object.fromEntries(DROP_CLASSES.map((k) => [k, 0]));
  const byTag = {};
  const ruleFp = new Map();
  for (const d of classified) {
    byClass[d.class]++;
    for (const t of d.tags) byTag[t] = (byTag[t] ?? 0) + 1;
    if (d.class === "rule-fp") {
      const token = d.candidate?.token ?? "unknown";
      ruleFp.set(token, (ruleFp.get(token) ?? 0) + 1);
    }
  }
  const ruleFpByRule = [...ruleFp].map(([token, drops]) => ({ token, drops })).sort((a, b) => b.drops - a.drops || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  return { total: classified.length, byClass, byTag, ruleFpByRule };
}

// A small seeded generator (mulberry32): the same seed gives the same
// numbers on every machine.
function generator(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n items drawn without repeats, in draw order: the first n of a seeded
// shuffle. Fewer when there are fewer items.
export function drawAudit(items, n, seed) {
  const pool = [...items];
  const next = generator(seed);
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(next() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

const lines = (start, end) => (end > start ? `lines ${start} to ${end}` : `line ${start}`);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The one redactor for every field an audit prints: each known run, build,
// configuration and case identifier becomes its kind in brackets ("[run]"),
// whatever its case, the longest first so a run id goes before the build
// inside it. `known` is [{ kind, value }].
export function redactor(known) {
  const byValue = new Map();
  for (const k of known) if (typeof k.value === "string" && k.value !== "") byValue.set(k.value.toLowerCase(), k.kind);
  if (byValue.size === 0) return (s) => String(s ?? "");
  const re = new RegExp([...byValue.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "gi");
  return (s) => String(s ?? "").replace(re, (m) => `[${byValue.get(m.toLowerCase())}]`);
}

// The drawn drops as both audit formats show them: the rule, the place, the
// cited line, the reason and the class, every text through the redactor,
// and nothing else of the sample.
export function auditItems(drawn, redact = (s) => String(s ?? "")) {
  return drawn.map((d, i) => {
    const c = d.candidate ?? {};
    return {
      item: i + 1,
      rule: redact(c.token ?? "unknown"),
      file: redact(normPath(c.filePath)),
      lineStart: c.lineStart ?? null,
      lineEnd: Math.max(c.lineEnd ?? c.lineStart, c.lineStart),
      cited: d.cited ? { file: redact(normPath(d.cited.file_path)), line: d.cited.line_number } : null,
      reason: redact(oneLine(d.reason)),
      class: d.class,
      tags: d.tags.map((t) => redact(t)),
      matched: { rule: d.matched.rule, text: d.matched.text === null ? null : redact(oneLine(d.matched.text)) },
    };
  });
}

// The audit sheet: each item with a line for the person's ruling.
export function auditSheet(items, { seed, of }) {
  const out = [
    "# Drop audit",
    "",
    `${items.length} dropped scanner candidates, drawn at random (seed ${seed}) from ${of}. For each, read the reason and the place, then write whether the class is right; when it is not, write the right class.`,
    "",
    `Classes, first match wins: ${DROP_CLASSES.join(", ")}.`,
    "",
  ];
  for (const x of items) {
    out.push(
      `## ${x.item}`,
      "",
      `- Rule: ${x.rule}`,
      `- Place: ${x.file}, ${lines(x.lineStart, x.lineEnd)}`,
      `- Cited line: ${x.cited ? `${x.cited.file}:${x.cited.line}` : "none"}`,
      `- Reason: ${x.reason}`,
      `- Class: ${x.class}${x.tags.length > 0 ? ` (${x.tags.join(", ")})` : ""}, by ${x.matched.rule}${x.matched.text ? ` "${x.matched.text}"` : ""}`,
      "- Ruling: ",
      "",
    );
  }
  return out.join("\n");
}
