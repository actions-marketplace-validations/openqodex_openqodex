// `openqodex findings <numbers>`: the findings the developer named, in full,
// from the last review of this repository run on this machine. The receipt
// `review` prints names each finding by its number and title only; once the
// developer says which to fix ("fix 1 and 3"), the agent prints those here:
// where, the problem, why it matters, the fix, any suggested change and the
// source. `all` prints every finding.
//
// The review is the one recorded in the developer's own OpenQodex home
// (receipts.ts), never the newest folder under .openqodex/reviews/, which a
// branch can carry with any name and any text. It only reads and prints.
import { join } from "node:path";
import { OpenQodexError, findRepoRoot, isRepoState, readFileBounded, readRepoFile, renderFindingDetails } from "@openqodex/core";
import type { Report } from "@openqodex/core";
import { EXIT_OK } from "../exit-codes.js";
import { parseFlags } from "../flags.js";
import { openqodexHomeDir } from "../launcher.js";
import { readHomeLastReview } from "../receipts.js";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_NUMBERS = 200;

// "1,3", "1, 3", "1 3" or "all", as given in one or more arguments.
function numbersOf(args: string[], count: number): number[] {
  const words = args.join(",").split(/[\s,]+/).filter((w) => w !== "");
  if (words.length === 0) throw new OpenQodexError("name the findings to print by their numbers in the receipt, such as openqodex findings 1,3, or all");
  if (words.length === 1 && words[0] === "all") return Array.from({ length: count }, (_, i) => i + 1);
  if (words.length > MAX_NUMBERS) throw new OpenQodexError(`name at most ${MAX_NUMBERS} findings at once, or all`);
  const out = new Set<number>();
  for (const w of words) {
    if (!/^[1-9]\d{0,5}$/.test(w)) throw new OpenQodexError(`${w} is not a finding number; use the numbers in the receipt, such as 1,3, or all`);
    const n = Number(w);
    if (n > count) {
      throw new OpenQodexError(`${n} is not a finding of the last review: it has ${count === 0 ? "no findings" : count === 1 ? "1 finding, number 1" : `${count} findings, numbered 1 to ${count}`}`);
    }
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function readReport(repoRoot: string, dir: string): string | null {
  const path = join(dir, "report.json");
  try {
    // In the repository: through the repo state reader, which follows no link.
    if (isRepoState(repoRoot, path) !== null) return readRepoFile(repoRoot, path, MAX_REPORT_BYTES);
    return readFileBounded(path, MAX_REPORT_BYTES, "", path, true);
  } catch {
    return null;
  }
}

export async function run(args: string[]): Promise<number> {
  const { global, positionals } = parseFlags(args, { positionals: MAX_NUMBERS, globals: ["--cwd"] });
  const repoRoot = await findRepoRoot(global.cwd);
  const last = readHomeLastReview(openqodexHomeDir(), repoRoot);
  if (last === null) throw new OpenQodexError("there is no review of this repository yet on this machine; run openqodex review first");
  const text = readReport(repoRoot, last.dir);
  let report: Report | null = null;
  try {
    report = text === null ? null : (JSON.parse(text) as Report);
  } catch {
    report = null;
  }
  if (report === null || report.kind !== "review" || report.change_id !== last.change_id || !Array.isArray(report.findings)) {
    throw new OpenQodexError(`the report of the last review is gone or changed (${join(last.dir, "report.json")}); run openqodex review again`);
  }
  const numbers = numbersOf(positionals, report.findings.length);
  process.stdout.write(`From the review in ${last.dir}\n\n${renderFindingDetails(report, numbers)}`);
  return EXIT_OK;
}
