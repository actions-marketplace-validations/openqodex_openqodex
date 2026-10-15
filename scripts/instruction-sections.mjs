// Generate the exact sections the resolver may strip from the templates init ships.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const templates = join(root, "packages/cli/templates");
const sections = new Set();
for (const name of readdirSync(templates, { recursive: true }).sort()) {
  if (!/\.(md|mdc)$/.test(name)) continue;
  const text = readFileSync(join(templates, name), "utf8");
  for (const [span] of text.matchAll(/^<!-- openqodex:start -->\n[\s\S]*?^<!-- openqodex:end -->$/gm)) sections.add(span);
}
const path = join(root, "packages/core/src/shipped-instruction-sections.json");
const text = JSON.stringify({ generatedBy: "scripts/instruction-sections.mjs", sections: [...sections] }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== text) throw new Error("shipped instruction sections differ from the templates; run node scripts/instruction-sections.mjs");
} else writeFileSync(path, text);
