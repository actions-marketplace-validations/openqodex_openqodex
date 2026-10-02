// Checks the skill and the plugin manifests. A file that does not exist yet is
// reported and skipped; a file that exists and is wrong fails the gate.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];

function present(rel) {
  if (existsSync(join(root, rel))) return true;
  console.log(`skipped: not present yet: ${rel}`);
  return false;
}

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), "utf8"));
  } catch (error) {
    errors.push(`${rel}: not valid JSON (${error.message})`);
    return undefined;
  }
}

const skill = "skills/openqodex/SKILL.md";
if (present(skill)) {
  const text = readFileSync(join(root, skill), "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    errors.push(`${skill}: no frontmatter`);
  } else {
    const front = match[1];
    const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const description = front.match(/^description:\s*(.*)$/m)?.[1]?.trim();
    if (name !== "openqodex") errors.push(`${skill}: frontmatter name must be openqodex`);
    if (!description) errors.push(`${skill}: frontmatter description is empty`);
  }
  if (!errors.length) console.log(`ok: ${skill}`);
}

const plugin = "plugins/claude-code/.claude-plugin/plugin.json";
if (present(plugin)) {
  const json = readJson(plugin);
  if (json && typeof json.name !== "string") errors.push(`${plugin}: missing name`);
  else if (json) console.log(`ok: ${plugin}`);
}

const hooks = "plugins/claude-code/hooks/hooks.json";
if (present(hooks)) {
  const json = readJson(hooks);
  if (json && (typeof json.hooks !== "object" || json.hooks === null)) {
    errors.push(`${hooks}: missing top-level hooks`);
  } else if (json) console.log(`ok: ${hooks}`);
}

const marketplace = ".claude-plugin/marketplace.json";
if (present(marketplace)) {
  const json = readJson(marketplace);
  if (json) {
    const before = errors.length;
    if (typeof json.name !== "string") errors.push(`${marketplace}: missing name`);
    if (typeof json.owner?.name !== "string") errors.push(`${marketplace}: missing owner.name`);
    if (!Array.isArray(json.plugins)) errors.push(`${marketplace}: missing plugins list`);
    if (errors.length === before) console.log(`ok: ${marketplace}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
