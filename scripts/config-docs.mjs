// Writes the key table and the table of config changes in docs/config.md
// from the config schema and CONFIG_CHANGES, so the docs and the parser
// cannot drift. `--check` writes nothing and fails when a committed table is
// stale. Reads the built core package: run after the build.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { CONFIG_CHANGES, CONFIG_KEYS, schemaKeys } = await import(join(root, "packages/core/dist/index.js"));
const page = join(root, "docs/config.md");

const listed = CONFIG_KEYS.map((k) => k.key);
const schema = schemaKeys();
if (listed.join("\n") !== schema.join("\n")) {
  console.error(`config-docs: CONFIG_KEYS and the schema differ.\nCONFIG_KEYS: ${listed.join(", ")}\nschema: ${schema.join(", ")}`);
  process.exit(1);
}

const keyRows = CONFIG_KEYS.map((k) => `| \`${k.key}\` | \`${k.default}\` | ${k.description} |`);
const keys = ["| Key | Default | What it does |", "| --- | --- | --- |", ...keyRows];

const defaultOf = (key) => CONFIG_KEYS.find((k) => k.key === key)?.default;
const changeRow = (c) => {
  switch (c.kind) {
    case "moved":
      return `| \`${c.file}\` moved to \`${c.to}\` | ${c.since} | The old file is still read while the new one is absent. \`config migrate\` moves it. |`;
    case "renamed":
      return `| \`${c.key}\` renamed to \`${c.to}\` | ${c.since} | It is ${c.why}. Read as \`${c.to}\`, with a warning; a file with both is refused. \`config migrate\` renames it. |`;
    case "removed":
      return `| \`${c.key}\` removed | ${c.since} | Ignored, with a warning: ${c.why}. \`config migrate\` removes it. |`;
    case "hosted":
      return `| \`${c.key}\` of the hosted review | | Ignored, with a warning. \`config migrate\` keeps it, so one file can serve both. |`;
    case "default":
      return `| \`${c.key}\` default \`${c.was}\` to \`${defaultOf(c.key)}\` | ${c.since} | A file an earlier \`init\` wrote with every default set that still holds \`${c.was}\` gets a warning.${c.unset ? " A file at the old place that leaves it unset gets one too." : ""} |`;
    default:
      throw new Error(`config-docs: no docs row for a change of kind ${c.kind}`);
  }
};
const changes = ["| Change | Since | What happens |", "| --- | --- | --- |", ...CONFIG_CHANGES.map(changeRow)];

let text = readFileSync(page, "utf8");
const original = text;
for (const [name, rows] of [["config-keys", keys], ["config-changes", changes]]) {
  const START = `<!-- ${name}:start -->`;
  const END = `<!-- ${name}:end -->`;
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    console.error(`config-docs: docs/config.md needs the markers ${START} and ${END}`);
    process.exit(1);
  }
  text = text.slice(0, from) + [START, ...rows, END].join("\n") + text.slice(to + END.length);
}

if (process.argv.includes("--check")) {
  if (text !== original) {
    console.error("config-docs: a table in docs/config.md is stale; run node scripts/config-docs.mjs");
    process.exit(1);
  }
  console.log("config-docs: the key table and the changes table in docs/config.md match the code");
} else {
  writeFileSync(page, text);
  console.log(`config-docs: wrote ${CONFIG_KEYS.length} keys and ${CONFIG_CHANGES.length} changes to docs/config.md`);
}
