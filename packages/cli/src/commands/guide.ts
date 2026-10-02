// `openqodex guide [topic]`: the docs that ship inside the package, so an
// agent can read them offline. No topic prints the skill.
import { readdirSync, readFileSync } from "node:fs";
import { assetPath } from "../assets.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { parseFlags } from "../flags.js";

function topics(): string[] {
  try {
    return readdirSync(assetPath("docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export async function run(args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, { positionals: 1 });
  const topic = positionals[0];
  if (topic === undefined) {
    process.stdout.write(readFileSync(assetPath("skills", "openqodex", "SKILL.md"), "utf8"));
    return EXIT_OK;
  }
  const available = topics();
  if (!available.includes(topic)) {
    const list = available.length > 0 ? available.join(", ") : "none in this package";
    process.stderr.write(`No guide named ${topic}. Topics: ${list}\n`);
    return EXIT_TOOL_FAILED;
  }
  process.stdout.write(readFileSync(assetPath("docs", `${topic}.md`), "utf8"));
  return EXIT_OK;
}
