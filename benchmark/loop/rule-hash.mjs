// The hash of the acceptance rule's own files (PLAN-benchmark 4.11): the
// comparison, the decision, the paired test and this file. A validation
// line names it, and decide.mjs refuses a live decision while the last
// validation names another. This module imports none of those files, so
// validate.mjs can hash them before it loads them and again before it
// writes its line.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RULE_FILES = Object.freeze(["./compare.mjs", "./decide.mjs", "./rule-hash.mjs", "../lib/interval.mjs"]);

// sha256 over each file's name and text, in RULE_FILES order, read from disk now.
export function ruleHash() {
  const h = createHash("sha256");
  for (const f of RULE_FILES) h.update(`${f}\0${readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")}\0`);
  return h.digest("hex");
}
