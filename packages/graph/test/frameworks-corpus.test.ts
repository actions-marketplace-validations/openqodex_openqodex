// The framework plugins' corpus cases (corpus/frameworks/<plugin>/), one
// group per plugin with its own scoring hook, so the cases of one plugin
// never wait on another's, and the same gate as the language corpus.
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCases } from "../corpus/score.js";
import { defineCorpus } from "./corpus-runner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const frameworks = join(root, "frameworks");

for (const plugin of readdirSync(frameworks).sort()) {
  const dir = join(frameworks, plugin);
  if (!statSync(dir).isDirectory()) continue;
  defineCorpus(`the ${plugin} plugin's corpus`, root, findCases(dir), 300_000);
}
