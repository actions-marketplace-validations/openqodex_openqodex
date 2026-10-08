// The one place that decides which built-in scanners a set of files calls
// for, and why. A review and a scan ask it about the change; `init`,
// `doctor --install` and the GitHub Action ask it about every file of the
// repo, to download ahead what the repo's reviews will need. All of them
// get the same answer for the same files and config.
//
// Order of the checks, the same as a review runs them: switched off in the
// config, then the files the scanner checks (by name, by the project a file
// belongs to, by its first bytes), then a reason it must not run at all
// (dependency lookups while offline).

import { display, matchesGlob, safeGit, STATE_DIR } from "@openqodex/core";
import type { BuiltinScanner, Config } from "@openqodex/core";
import { ADAPTERS, IN_PROCESS } from "./adapters/index.js";
import { repoFacts, type RepoFacts } from "./detect.js";

export type ScannerChoice = {
  scanner: BuiltinScanner;
  // True when the scanner runs for these files: it downloads ahead unless
  // it runs inside OpenQodex (`inProcess`).
  wanted: boolean;
  inProcess: boolean;
  // The files that call for it.
  paths: string[];
  // The project folders that decide how it runs ("" is the repo root):
  // the Rails apps brakeman runs in, the projects whose framework rules
  // oxlint, ruff or rubocop switch on.
  projects: string[];
  // Why it runs, when wanted: "Rails app in backend/".
  reason: string | null;
  // Why it does not, when not wanted.
  skip: string | null;
};

export const DISABLED_REASON = "disabled in .openqodex/config.yaml";
export const NOTHING_TO_CHECK = "nothing to check";

export function selectScanners(args: { repoDir: string; paths: string[]; config: Config; facts?: RepoFacts }): ScannerChoice[] {
  const facts = args.facts ?? repoFacts(args.repoDir);
  return ADAPTERS.map((adapter) => {
    const base = { scanner: adapter.source, inProcess: IN_PROCESS.has(adapter.source), paths: [] as string[], projects: [] as string[], reason: null };
    if (args.config.disabledScanners.includes(adapter.source)) return { ...base, wanted: false, skip: DISABLED_REASON };
    const files = adapter.files(args.paths, facts);
    if (files.length === 0) return { ...base, wanted: false, skip: adapter.idle?.(args.paths, facts) ?? NOTHING_TO_CHECK };
    const projects = adapter.projects?.(files, facts) ?? [];
    const skip = adapter.skip?.() ?? null;
    if (skip) return { ...base, paths: files, projects, wanted: false, skip };
    return { ...base, paths: files, projects, wanted: true, reason: adapter.why(files, facts), skip: null };
  });
}

// "brakeman: Rails app in backend/", one line with no control character,
// whatever a file name holds.
export function choiceLine(choice: ScannerChoice): string {
  const text = display(`${choice.scanner}: ${choice.wanted ? choice.reason : choice.skip}`);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

// The scanners to download for these choices: wanted, with a tool.
export function downloadsFor(choices: ScannerChoice[]): BuiltinScanner[] {
  return choices.filter((c) => c.wanted && !c.inProcess).map((c) => c.scanner);
}

// Every file a repo-wide pre-install reads: tracked files and untracked files
// git does not ignore, as a whole-repo review lists them, less the config's
// excludes and OpenQodex's own folder.
export async function repoInventory(repoDir: string, config: Config): Promise<string[]> {
  const listed = await safeGit(repoDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim().split("\n")[0] ?? ""}`);
  const paths = new Set(listed.stdout.toString("utf8").split("\0").filter((p) => p !== ""));
  return [...paths]
    .filter((p) => p !== STATE_DIR && !p.startsWith(`${STATE_DIR}/`) && !config.exclude.some((g) => matchesGlob(p, g)))
    .sort();
}
