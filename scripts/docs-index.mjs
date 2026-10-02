// Writes docs/llms.txt: one line per page in docs/, so agents can find them.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = join(root, "docs");
mkdirSync(docs, { recursive: true });

const pages = existsSync(docs)
  ? readdirSync(docs).filter((name) => name.endsWith(".md")).sort()
  : [];

const lines = ["# OpenQodex docs", ""];
for (const page of pages) {
  const text = readFileSync(join(docs, page), "utf8");
  const heading = text.split("\n").find((line) => line.startsWith("# "));
  const title = heading ? heading.slice(2).trim() : page.replace(/\.md$/, "");
  lines.push(`- [${title}](${page})`);
}

writeFileSync(join(docs, "llms.txt"), `${lines.join("\n")}\n`);
console.log(`docs/llms.txt lists ${pages.length} page(s)`);
