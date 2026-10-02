// Brakeman adapter (Rails SAST). Runs `brakeman -q -f json
// --no-progress` at the repo root and normalizes the vendor JSON
// `warnings[]` into StaticFinding[]. Brakeman is the only scanner in the
// ensemble that understands Rails: it follows SQL injection through
// ActiveRecord, cross-site scripting through views, mass assignment,
// unsafe redirects, command injection, and CSRF / auth gaps that a
// generic linter never sees.
//
// Brakeman is a whole-project scanner (no per-file invocation), so we
// gate it on Rails applicability before spawning: a Gemfile AND an
// app/ directory at the repo root, AND a changed Rails-relevant file.
// We anchor the warnings to changed lines downstream (the ensemble's
// filterToChangedLines), so a project-wide scan only ever surfaces hits
// on lines this change touched. With these flags it prints its report to
// stdout and writes nothing to disk.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import fs from "node:fs";
import path from "node:path";
import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import type { Adapter } from "./index.js";

// Brakeman walks the whole app tree, so give it more headroom than the
// file-scoped scanners.
const BRAKEMAN_TIMEOUT_MS = 120_000;
const BRAKEMAN_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

// A Rails-relevant changed file: Ruby source, a view template (ERB /
// HAML / Slim can introduce XSS), or Gemfile / Rakefile / config.ru. A
// README or frontend-only change cannot introduce a Rails vuln Brakeman
// would surface, so it must not trigger the full-project scan.
function isRailsRelevantPath(p: string): boolean {
  return (
    /\.(rb|rake|gemspec|erb|haml|slim)$/i.test(p) ||
    /(^|\/)(Gemfile|Rakefile|config\.ru)$/i.test(p)
  );
}

// Applicability gate. Run Brakeman only when BOTH the change touched a
// Rails-relevant file AND the repo is actually a Rails app (a Gemfile +
// an app/ dir). Gating on the changed paths first avoids a wasted
// full-project scan on a docs/frontend-only change in a Rails repo; the
// Gemfile/app check then confirms brakeman won't just error on a
// non-Rails directory.
function looksLikeRails(repoDir: string, changedPaths: string[]): boolean {
  if (!changedPaths.some(isRailsRelevantPath)) return false;
  try {
    const hasGemfile = fs.existsSync(path.join(repoDir, "Gemfile"));
    const appPath = path.join(repoDir, "app");
    const hasAppDir = fs.existsSync(appPath) && fs.statSync(appPath).isDirectory();
    return hasGemfile && hasAppDir;
  } catch {
    return false;
  }
}

export async function runBrakeman(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
}): Promise<AdapterResult> {
  if (!looksLikeRails(args.repoDir, args.changedPaths)) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  // -q quiet, -f json the stable machine shape, --no-progress to keep
  // stdout pure JSON. No path arg: brakeman defaults to the cwd we set.
  const cliArgs = ["-q", "-f", "json", "--no-progress"];

  let stdout: string;
  try {
    stdout = await execBrakeman(args.tool, cliArgs, args.repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }

  try {
    return { findings: parseBrakemanJson(stdout), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: `parse: ${message.slice(0, 200)}` };
  }
}

async function execBrakeman(tool: ResolvedTool, cliArgs: string[], cwd: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs: BRAKEMAN_TIMEOUT_MS,
    maxBytes: BRAKEMAN_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // Brakeman exit codes are messy: the default run exits 0 even
  // with warnings, but some versions / scan errors return
  // non-zero while STILL emitting the JSON report on stdout. So
  // prefer stdout whenever it's present and only treat a missing
  // binary or an empty-output failure as fatal.
  const failed = describeFailure("brakeman", result, BRAKEMAN_TIMEOUT_MS);
  if (result.failure === "not_found" && failed) throw new Error(failed);
  if (result.stdout.trim()) return result.stdout;
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(`brakeman exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const brakeman: Adapter = {
  source: "brakeman",
  wants: (changedPaths, repoDir) => looksLikeRails(repoDir, changedPaths),
  run: (args) => runBrakeman(args),
};

type BrakemanWarning = {
  warning_type?: unknown;
  check_name?: unknown;
  message?: unknown;
  file?: unknown;
  line?: unknown;
  confidence?: unknown;
  code?: unknown;
  user_input?: unknown;
  link?: unknown;
};

export function parseBrakemanJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { warnings?: unknown };
  if (!parsed || !Array.isArray(parsed.warnings)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed.warnings as BrakemanWarning[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.file === "string" ? raw.file : "";
    const line = numberOrZero(raw.line);
    // check_name is the stable per-check id (e.g. "SQL",
    // "CrossSiteScripting"); warning_type is the human label.
    const ruleId = typeof raw.check_name === "string" && raw.check_name ? raw.check_name : "brakeman";
    // Warnings on the Gemfile / config without a line can't be anchored
    // to a changed diff line, so drop them like every other adapter.
    if (!filePath || line <= 0) continue;
    out.push({
      source: "brakeman",
      ruleId,
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: confidenceToSeverity(raw.confidence),
      message: buildMessage(raw),
      reference: typeof raw.link === "string" && raw.link ? raw.link : null,
    });
  }
  return out;
}

// Brakeman warnings are always security findings; rank them by
// Brakeman's own confidence so the high-confidence injection /
// XSS hits sort above the speculative ones.
function confidenceToSeverity(raw: unknown): StaticFindingSeverity {
  if (typeof raw !== "string") return "medium";
  switch (raw.toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "weak":
      return "low";
    default:
      return "medium";
  }
}

// "<warning_type>: <message> [<short detail>]" where the detail is the
// flagged code snippet (or the user input it derived from). Gives the
// reviewer enough to locate the sink without dumping the whole node.
function buildMessage(raw: BrakemanWarning): string {
  const type = typeof raw.warning_type === "string" ? raw.warning_type : "";
  const body = typeof raw.message === "string" ? raw.message : "";
  const head = type && body ? `${type}: ${body}` : type || body;
  const detail =
    typeof raw.code === "string" && raw.code
      ? raw.code
      : typeof raw.user_input === "string" && raw.user_input
        ? raw.user_input
        : "";
  const full = detail ? `${head} [${detail}]` : head;
  return trimMessage(full);
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
