// Writes the key table in docs/config.md from the config schema, so the docs
// and the parser cannot drift. `--check` writes nothing and fails when the
// committed table is stale. Reads the built core package: run after the build.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { CONFIG_KEYS, schemaKeys } = await import(join(root, "packages/core/dist/index.js"));
const page = join(root, "docs/config.md");
const START = "<!-- config-keys:start -->";
const END = "<!-- config-keys:end -->";

const listed = CONFIG_KEYS.map((k) => k.key);
const schema = schemaKeys();
if (listed.join("\n") !== schema.join("\n")) {
  console.error(`config-docs: CONFIG_KEYS and the schema differ.\nCONFIG_KEYS: ${listed.join(", ")}\nschema: ${schema.join(", ")}`);
  process.exit(1);
}

const rows = CONFIG_KEYS.map((k) => `| \`${k.key}\` | \`${k.default}\` | ${k.description} |`);
const table = [START, "| Key | Default | What it does |", "| --- | --- | --- |", ...rows, END].join("\n");

const text = readFileSync(page, "utf8");
const from = text.indexOf(START);
const to = text.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(`config-docs: docs/config.md needs the markers ${START} and ${END}`);
  process.exit(1);
}
const next = text.slice(0, from) + table + text.slice(to + END.length);

if (process.argv.includes("--check")) {
  if (next !== text) {
    console.error("config-docs: the key table in docs/config.md is stale; run node scripts/config-docs.mjs");
    process.exit(1);
  }
  console.log("config-docs: the key table in docs/config.md matches the schema");
} else {
  writeFileSync(page, next);
  console.log(`config-docs: wrote ${CONFIG_KEYS.length} keys to docs/config.md`);
}
