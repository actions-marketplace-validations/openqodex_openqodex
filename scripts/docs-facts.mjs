// Holds the facts in the README and the agent-facing docs to the code, where
// a script can read the code's answer. It reads the built packages: run it
// after the build. It writes nothing; it fails when a page and the code
// disagree, and names each place.
//
// It checks:
//  1. every "<number> built-in scanners" in the pages equals the adapter list;
//  2. the table in docs/scanners.md names each built-in scanner once, with
//     its version from packages/scanners/toolchain.json, and the README's
//     category counts equal that table's;
//  3. every sentence that says what `--offline` skips names exactly the
//     scanners whose adapters skip themselves when offline;
//  4. every command in a code example is one the CLI's own help knows, and
//     every flag in it is in that command's own flag list;
//  5. every pinned `openqodex@x.y.z` names the package version;
//  6. every README link is absolute, so it works on the npm page; every
//     link into this repository names a file that exists.
// It cannot check what a sentence means, a measured time or a privacy
// promise. Those are in the manual claims ledger.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), "utf8");
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

const { ADAPTERS, IN_PROCESS } = await import(join(root, "packages/scanners/dist/index.js"));
const toolchain = JSON.parse(read("packages/scanners/toolchain.json")).tools;
const version = JSON.parse(read("packages/cli/package.json")).version;
const BIN = join(root, "packages/cli/dist/bin.js");

const README = "README.md";
const AGENT_PAGES = [README, "docs/for-agents.md", "docs/quickstart.md", "skills/openqodex/SKILL.md"];

// The names the pages use for a scanner, by adapter source.
const DISPLAY = { golangci: "golangci-lint", checkov: "Checkov", tflint: "TFLint", sqlfluff: "SQLFluff" };
const display = (source) => DISPLAY[source] ?? source;
const sources = ADAPTERS.map((a) => a.source);
const sourceOf = new Map(sources.map((s) => [display(s).toLowerCase(), s]));

// Code spans and fenced blocks are left out of prose checks, and are the
// only text the command check reads.
function splitCode(text) {
  const code = [];
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    code.push(m.replace(/^`+|`+$/g, ""));
    return " ";
  });
  return { code, prose };
}

// 1. The count of built-in scanners.
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = { twenty: 20, thirty: 30, forty: 40 };
function numberOf(word) {
  if (/^\d+$/.test(word)) return Number(word);
  const w = word.toLowerCase();
  if (WORDS.includes(w)) return WORDS.indexOf(w);
  const [tens, unit] = w.split("-");
  if (tens in TENS) return TENS[tens] + (unit === undefined ? 0 : WORDS.indexOf(unit));
  return null;
}
for (const rel of [README, "docs/index.md", "docs/scanners.md", "docs/for-agents.md"]) {
  const matches = [...read(rel).matchAll(/\b([A-Za-z]+(?:-[a-z]+)?|\d+) built-in scanners\b/g)];
  const counts = matches.map((m) => [m[1], numberOf(m[1])]).filter(([, n]) => n !== null);
  if (counts.length === 0) fail(rel, `says nowhere how many built-in scanners there are (${ADAPTERS.length})`);
  for (const [word, n] of counts) if (n !== ADAPTERS.length) fail(rel, `says "${word} built-in scanners"; the adapter list has ${ADAPTERS.length}`);
}

// 2. The scanner table and the README's category counts.
function tableRows(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + 1);
  if (from === -1 || to === -1) return null;
  return text
    .slice(from, to)
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l))
    .slice(1)
    .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
}
const SCANNERS_PAGE = "docs/scanners.md";
const rows = tableRows(read(SCANNERS_PAGE), "<!-- scanner-table:start -->", "<!-- scanner-table:end -->");
const perCategory = new Map();
if (rows === null) fail(SCANNERS_PAGE, "has no table between <!-- scanner-table:start --> and <!-- scanner-table:end -->");
else {
  const seen = new Set();
  for (const [category, name, listed] of rows) {
    const source = sourceOf.get((name ?? "").toLowerCase());
    if (source === undefined) {
      fail(SCANNERS_PAGE, `the table names "${name}", which is not a built-in scanner`);
      continue;
    }
    if (seen.has(source)) fail(SCANNERS_PAGE, `the table names ${name} twice`);
    seen.add(source);
    const pinned = IN_PROCESS.has(source) ? "built in" : toolchain[source]?.version;
    if (listed !== pinned) fail(SCANNERS_PAGE, `${name} is listed at ${listed}; toolchain.json pins ${pinned}`);
    perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
  }
  for (const source of sources) if (!seen.has(source)) fail(SCANNERS_PAGE, `the table leaves out ${display(source)}`);
}
const readmeText = read(README);
const section = readmeText.slice(readmeText.indexOf("## Built-in scanners"));
const readmeRows = tableRows(section, "| What it checks", "\n\n");
if (readmeRows === null || readmeRows.length === 0) fail(README, `has no category table under "## Built-in scanners"`);
else {
  let sum = 0;
  for (const [category, count] of readmeRows) {
    sum += Number(count);
    if (perCategory.get(category) !== Number(count)) fail(README, `counts ${count} for "${category}"; ${SCANNERS_PAGE} lists ${perCategory.get(category) ?? 0}`);
  }
  if (sum !== ADAPTERS.length) fail(README, `its category counts add up to ${sum}; the adapter list has ${ADAPTERS.length}`);
  for (const category of perCategory.keys()) if (!readmeRows.some(([c]) => c === category)) fail(README, `leaves out the category "${category}"`);
}

// 3. What --offline skips: the adapters that refuse to run when offline.
process.env.OPENQODEX_OFFLINE = "1";
const offline = new Set(ADAPTERS.filter((a) => typeof a.skip === "function" && a.skip() !== null).map((a) => a.source));
const names = [...sourceOf.keys()].sort((a, b) => b.length - a.length);
for (const rel of [README, "docs/for-agents.md", "skills/openqodex/SKILL.md", "docs/privacy.md", "docs/security.md"]) {
  const sentences = read(rel).split(/(?<=\.)\s+|\n/).filter((s) => s.includes("`--offline` skips"));
  if (sentences.length === 0) fail(rel, "never says what `--offline` skips");
  for (const sentence of sentences) {
    const named = new Set(names.filter((n) => new RegExp(`(^|[^\\w-])${n.replace(/[-]/g, "\\-")}([^\\w-]|$)`, "i").test(sentence)).map((n) => sourceOf.get(n)));
    const missing = [...offline].filter((s) => !named.has(s));
    const extra = [...named].filter((s) => !offline.has(s));
    if (missing.length || extra.length) fail(rel, `"${sentence.trim().slice(0, 90)}..." ${missing.length ? `leaves out ${missing.join(", ")}` : ""}${missing.length && extra.length ? " and " : ""}${extra.length ? `names ${extra.join(", ")}, which run offline` : ""}`);
  }
}

// 4. Commands and flags in code examples.
const helpCache = new Map();
function known(command) {
  if (!helpCache.has(command)) {
    let out = "";
    try {
      out = execFileSync(process.execPath, [BIN, command, "--help"], { encoding: "utf8", env: { ...process.env, CI: "1", OPENQODEX_AUTO_UPDATE: "0" } });
    } catch (error) {
      out = String(error.stdout ?? "");
    }
    helpCache.set(command, out.startsWith(`Usage: openqodex ${command}`));
  }
  return helpCache.get(command);
}
const FLAG_FILES = { review: ["review.ts", "../flags.ts"], scan: ["scan.ts", "../flags.ts"], doctor: ["doctor.ts", "../flags.ts"], demo: ["demo.ts", "../flags.ts"], trust: ["trust.ts", "../flags.ts"], findings: ["findings.ts", "../flags.ts"], graph: ["graph.ts", "../flags.ts"], init: ["init.ts"], update: ["update.ts"], guide: ["guide.ts", "../flags.ts"], config: ["config.ts", "../flags.ts"], report: ["report.ts", "../flags.ts"], hook: ["hook.ts"], mcp: ["mcp.ts"] };
function flagsOf(command) {
  const files = FLAG_FILES[command] ?? [`${command}.ts`];
  const text = files.map((f) => {
    const path = join(root, "packages/cli/src/commands", f);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }).join("\n");
  return new Set([...text.matchAll(/"(--[a-z][a-z-]*)"/g)].map((m) => m[1]));
}
for (const rel of [README, "docs/for-agents.md"]) {
  for (const code of splitCode(read(rel)).code) {
    for (const m of code.matchAll(/(?:^|[\s(])(?:npx (?:-y )?)?(?:~\/\.openqodex\/bin\/)?openqodex(?:@\d+\.\d+\.\d+)? ([a-z][a-z-]*)([^\n]*)/g)) {
      const [, command, rest] = m;
      if (!known(command)) {
        fail(rel, `\`openqodex ${command}\` is not a command the CLI's help knows`);
        continue;
      }
      const args = rest.split(/&&|\||;/)[0];
      const flags = flagsOf(command);
      for (const flag of args.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []) {
        if (!flags.has(flag)) fail(rel, `\`openqodex ${command}\` has no flag ${flag}`);
      }
    }
  }
}

// 5. Version pins.
for (const rel of AGENT_PAGES) {
  for (const pin of new Set(read(rel).match(/openqodex@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) ?? [])) {
    if (pin !== `openqodex@${version}`) fail(rel, `pins ${pin}; the package is ${version}`);
  }
}

// 6. Links.
const REPO = "https://github.com/openqodex/openqodex/blob/";
function links(text) {
  return [...splitCode(text).prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
}
for (const href of links(readmeText)) {
  if (!href.startsWith("https://")) fail(README, `links ${href}, which does not work on the npm page; use an absolute https link`);
}
const docsPages = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`);
for (const rel of [README, ...docsPages]) {
  for (const href of links(read(rel))) {
    const path = href.split("#")[0];
    if (href.startsWith(REPO)) {
      const inRepo = path.slice(REPO.length).split("/").slice(1).join("/");
      if (inRepo && !existsSync(join(root, inRepo))) fail(rel, `links ${href}, but ${inRepo} is not in the repository`);
    } else if (path && !/^[a-z]+:/.test(path) && !existsSync(join(root, normalize(join(dirname(rel), path))))) {
      fail(rel, `links ${href}, which does not exist`);
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`docs-facts: ${error}`);
  process.exit(1);
}
console.log(`ok: docs facts (${ADAPTERS.length} scanners, ${offline.size} skipped offline, version ${version})`);
