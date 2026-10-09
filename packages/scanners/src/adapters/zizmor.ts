// zizmor adapter (GitHub Actions security audit). Runs
// `zizmor --offline --no-exit-codes --format json-v1 -- <files>` from the
// repository root on the changed workflow, action and Dependabot files, and
// turns its findings into StaticFinding[]. It finds what actionlint's syntax
// checks do not: an attacker's text expanded into a script (template
// injection), dangerous triggers such as pull_request_target, actions not
// pinned to a commit, credentials left in the checkout, default permissions,
// and Dependabot updates that run the dependency's code.
//
// zizmor reads each file it is given by its name (crates/zizmor/src/registry/
// input.rs at v1.30.1): a .yml or .yaml under .github/workflows/ is a
// workflow, `action.yml` or `action.yaml` elsewhere an action, and
// `dependabot.yml` a Dependabot config. Any other YAML file named would be
// read as a workflow, so the gate names only the files GitHub reads as one
// of the three.
//
// What it may read and do, checked against the source and the binary:
// - `--offline`: no audit that asks the GitHub API runs, and no token is
//   used (scannerEnv passes none, so GH_TOKEN and GITHUB_TOKEN never reach
//   it).
// - Its settings: the repo's own zizmor.yml, from the repository root only,
//   passed by path, or `--no-config` when there is none. Left to itself,
//   zizmor walks up from the file's folder to the filesystem root when the
//   repo has no `.git` folder (a worktree has a `.git` file), and so could
//   read a zizmor.yml outside the repository. The file holds rule settings
//   only: a rule switched off, ignore entries, allow lists and severity
//   changes (RawConfig and AuditRuleConfig in crates/zizmor/src/config/
//   mod.rs, with unknown keys refused), so it cannot make zizmor run code or
//   write a file.
// - It never writes: `--fix` is the only flag that changes files, and it is
//   never passed. With `--offline` it fetches nothing, so its HTTP cache is
//   never used.
// - `--no-exit-codes`: findings exit 0, like no findings, instead of 11 to 14
//   by severity; any other exit is the tool failing. Exit 3 means none of the
//   files could be parsed.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import fs from "node:fs/promises";
import path from "node:path";
import { describeFailure, execTool, runInChunks, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";
import { repoFileOrReason } from "./read.js";
import { suchAs } from "./words.js";

const ZIZMOR_TIMEOUT_MS = 60_000;
const ZIZMOR_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const ZIZMOR_CONFIG_MAX_BYTES = 1024 * 1024;

// The settings files zizmor looks for at the repository root, in its order
// (CONFIG_CANDIDATES in crates/zizmor/src/config/mod.rs).
export const ZIZMOR_CONFIGS = [".github/zizmor.yml", ".github/zizmor.yaml", "zizmor.yml", "zizmor.yaml"] as const;

// The workflow files actionlint takes: GitHub runs only the ones directly
// under .github/workflows/.
const WORKFLOW = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
// An action's metadata file, in any folder: `uses: ./path` reads it there.
const ACTION = /(?:^|\/)action\.ya?ml$/;
// Dependabot reads its config from the repository root's .github/ only.
const DEPENDABOT = /^\.github\/dependabot\.ya?ml$/;

function isZizmorPath(p: string): boolean {
  return WORKFLOW.test(p) || ACTION.test(p) || DEPENDABOT.test(p);
}

const zizmorFiles = (changedPaths: string[]): string[] => safeFileArgs(changedPaths.filter(isZizmorPath));

// The flag that names zizmor's settings: the first candidate at the root that
// is a file, if it is a regular file inside the repository; `--no-config`
// otherwise, so zizmor never looks above the repository. A candidate that is
// a link out of the repository, or too large, turns the settings off rather
// than letting zizmor read it.
async function configArgs(repoDir: string): Promise<string[]> {
  for (const rel of ZIZMOR_CONFIGS) {
    let stat;
    try {
      stat = await fs.lstat(path.join(repoDir, rel));
    } catch {
      continue;
    }
    if (stat.isDirectory()) continue;
    try {
      const checked = await repoFileOrReason(repoDir, rel, ZIZMOR_CONFIG_MAX_BYTES);
      return "reason" in checked ? ["--no-config"] : ["--config", checked.path];
    } catch {
      return ["--no-config"];
    }
  }
  return ["--no-config"];
}

export async function runZizmor(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
}): Promise<AdapterResult> {
  const files = zizmorFiles(args.changedPaths);
  if (files.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const config = await configArgs(args.repoDir);
  // --no-progress and --color never: plain logs on stderr. --format json-v1:
  // the versioned machine shape.
  const cliArgs = (chunk: string[]): string[] => [
    "--offline",
    ...config,
    "--no-progress",
    "--no-exit-codes",
    "--color",
    "never",
    "--format",
    "json-v1",
    "--",
    ...chunk,
  ];

  // One process per chunk of files, so a whole-repo file list stays under
  // the argument limit; the findings of every chunk are merged.
  const tool = args.tool;
  try {
    const findings = await runInChunks("zizmor", files, ZIZMOR_TIMEOUT_MS, async (chunk, left) => {
      const stdout = await execZizmor(tool, cliArgs(chunk), args.repoDir, left);
      try {
        return parseZizmorJson(stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`parse: ${message.slice(0, 200)}`);
      }
    });
    return { findings, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

async function execZizmor(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: ZIZMOR_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  const failed = describeFailure("zizmor", result, ZIZMOR_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode === 3) throw new Error(`zizmor could not parse any of the files: ${stderrTail(result)}`);
  if (result.exitCode !== 0) throw new Error(`zizmor exit ${result.exitCode}: ${stderrTail(result)}`);
  return result.stdout;
}

export const zizmor: Adapter = {
  source: "zizmor",
  files: zizmorFiles,
  why: (files) => `GitHub workflow, action or Dependabot files, ${suchAs(files)}`,
  run: (args) => runZizmor(args),
};

type Point = { row?: unknown; column?: unknown };
type ZizmorLocation = {
  symbolic?: { key?: { Local?: { verbatim_path?: unknown } }; annotation?: unknown; kind?: unknown };
  concrete?: { location?: { start_point?: Point; end_point?: Point } };
};
type ZizmorFinding = {
  ident?: unknown;
  desc?: unknown;
  url?: unknown;
  determinations?: { severity?: unknown; confidence?: unknown };
  locations?: unknown;
};

export function parseZizmorJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed as ZizmorFinding[]) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.locations)) continue;
    // The primary location is where zizmor points at the problem; the
    // others (the whole step, the `run` key) give context.
    const primary = (raw.locations as ZizmorLocation[]).find((l) => l?.symbolic?.kind === "Primary");
    const filePath = primary?.symbolic?.key?.Local?.verbatim_path;
    const start = primary?.concrete?.location?.start_point?.row;
    const end = primary?.concrete?.location?.end_point;
    const endRow = end?.row;
    if (typeof filePath !== "string" || !filePath || !isRow(start) || !isRow(endRow)) continue;
    const lineStart = start + 1;
    // A span that ends at column 0 ends at the start of that row, so its
    // last character is on the row before.
    const lastRow = endRow > start && end?.column === 0 ? endRow - 1 : endRow;
    const ruleId = typeof raw.ident === "string" && raw.ident ? raw.ident : "zizmor";
    const desc = typeof raw.desc === "string" ? raw.desc : "";
    const note = typeof primary?.symbolic?.annotation === "string" ? primary.symbolic.annotation : "";
    out.push({
      source: "zizmor",
      ruleId,
      filePath,
      lineStart,
      lineEnd: Math.max(lineStart, lastRow + 1),
      severity: severityOf(raw.determinations?.severity, raw.determinations?.confidence),
      message: trimMessage(desc && note ? `${desc}: ${note}` : desc || note || ruleId),
      reference: typeof raw.url === "string" && raw.url ? raw.url : null,
    });
  }
  return out;
}

function isRow(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

const SCALE: StaticFindingSeverity[] = ["info", "low", "medium", "high"];
const RANK: Record<string, number> = { Informational: 0, Low: 1, Medium: 2, High: 3 };

// zizmor's severity (Informational, Low, Medium, High) on our scale; a
// finding zizmor itself holds at low confidence ranks one step lower.
function severityOf(severity: unknown, confidence: unknown): StaticFindingSeverity {
  const index = RANK[typeof severity === "string" ? severity : ""] ?? 2;
  return SCALE[Math.max(0, index - (confidence === "Low" ? 1 : 0))] as StaticFindingSeverity;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
