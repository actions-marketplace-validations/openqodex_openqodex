// Writes the CLI package version into every file that pins it: the skill, its
// plugin copy, the plugin manifest and the plugin hook. Run after `changeset
// version`; the gate fails when any of them differs from the package version.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;

for (const rel of [
  "skills/openqodex/SKILL.md",
  "plugins/claude-code/skills/openqodex/SKILL.md",
  "plugins/claude-code/hooks/hooks.json",
]) {
  const file = join(root, rel);
  const before = readFileSync(file, "utf8");
  const after = before.replace(/openqodex@[0-9][^\s"`)]*/g, `openqodex@${version}`);
  if (after !== before) writeFileSync(file, after);
  console.log(`${after === before ? "unchanged" : "updated"}: ${rel}`);
}

const pluginFile = join(root, "plugins/claude-code/.claude-plugin/plugin.json");
const plugin = JSON.parse(readFileSync(pluginFile, "utf8"));
if (plugin.version !== version) {
  plugin.version = version;
  writeFileSync(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);
  console.log("updated: plugins/claude-code/.claude-plugin/plugin.json");
}
