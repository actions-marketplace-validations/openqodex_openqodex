// Writes docs/llms.txt: one line per page in docs/, so agents can find them.
// The agent guide comes first, then every other page by file name.
// `--check` writes nothing and fails when the committed file differs.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = join(root, "docs");
const target = join(docs, "llms.txt");
const check = process.argv.includes("--check");
const FIRST = ["for-agents.md"];

const pages = existsSync(docs) ? readdirSync(docs).filter((name) => name.endsWith(".md")).sort() : [];
const ordered = [...FIRST.filter((name) => pages.includes(name)), ...pages.filter((name) => !FIRST.includes(name))];

const lines = ["# OpenQodex docs", ""];
for (const page of ordered) {
  const text = readFileSync(join(docs, page), "utf8");
  const heading = text.split("\n").find((line) => line.startsWith("# "));
  const title = heading ? heading.slice(2).trim() : page.replace(/\.md$/, "");
  lines.push(`- [${title}](${page})`);
}
const expected = `${lines.join("\n")}\n`;

if (check) {
  const committed = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (committed !== expected) {
    console.error("docs/llms.txt is out of date: run pnpm docs:index and commit the result.");
    process.exit(1);
  }
  console.log(`ok: docs/llms.txt lists ${ordered.length} page(s)`);
} else {
  mkdirSync(docs, { recursive: true });
  writeFileSync(target, expected);
  console.log(`docs/llms.txt lists ${ordered.length} page(s)`);
}
