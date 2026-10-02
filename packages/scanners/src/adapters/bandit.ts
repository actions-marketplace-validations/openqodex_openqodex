// Bandit adapter (Python SAST). Runs `bandit -f json -q <files>`
// against the changed Python files in the working tree and normalizes the
// vendor JSON `results[]` into StaticFinding[]. Bandit is the security
// (SAST) half of the Python coverage Ruff's lint pass misses: it flags
// the dangerous-API space directly. shell=True / os.system command
// injection, the subprocess + shell footguns, yaml.load and pickle
// deserialization, hardcoded passwords, weak crypto (md5 / DES), assert
// in production, and the SQL-string-build injection (B608) family.
//
// We invoke it only on changed .py / .pyi files so a change without
// Python is a no-op. Bandit emits one JSON object with a results[] array;
// every hit is a security finding, ranked by its own issue_severity.
// Findings are anchored to changed lines downstream (filterToChangedLines).
// It writes nothing to disk.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";

const BANDIT_TIMEOUT_MS = 60_000;
const BANDIT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

function isPythonPath(p: string): boolean {
  return /\.pyi?$/i.test(p);
}

export async function runBandit(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
}): Promise<AdapterResult> {
  const pyFiles = safeFileArgs(args.changedPaths.filter(isPythonPath));
  if (pyFiles.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  // -f json: the stable machine shape. -q: keep the progress chatter out
  // of the report. Changed files are passed positionally so it scans
  // only those.
  const cliArgs = ["-f", "json", "-q", "--", ...pyFiles];

  let stdout: string;
  try {
    stdout = await execBandit(args.tool, cliArgs, args.repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }

  try {
    return { findings: parseBanditJson(stdout), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: `parse: ${message.slice(0, 200)}` };
  }
}

async function execBandit(tool: ResolvedTool, cliArgs: string[], cwd: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs: BANDIT_TIMEOUT_MS,
    maxBytes: BANDIT_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // Bandit exit codes: 0 = no issues, 1 = issues found, 2 =
  // usage / internal error. It writes the JSON report to stdout
  // for both 0 and 1 (and on a per-file parse failure still emits
  // a JSON object carrying the failure under errors[]). Prefer
  // stdout whenever present; only a missing binary or an
  // empty-output failure is fatal.
  // Only a process that never started is fatal before stdout is read.
  if (result.failure === "not_found") throw new Error(describeFailure("bandit", result, BANDIT_TIMEOUT_MS) ?? "");
  if (result.stdout.trim()) return result.stdout;
  const failed = describeFailure("bandit", result, BANDIT_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(`bandit exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const bandit: Adapter = {
  source: "bandit",
  wants: (changedPaths) => safeFileArgs(changedPaths.filter(isPythonPath)).length > 0,
  run: (args) => runBandit(args),
};

type BanditResult = {
  filename?: unknown;
  line_number?: unknown;
  issue_severity?: unknown;
  issue_text?: unknown;
  test_id?: unknown;
  more_info?: unknown;
};

export function parseBanditJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { results?: unknown };
  if (!parsed || !Array.isArray(parsed.results)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed.results as BanditResult[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.filename === "string" ? raw.filename : "";
    const line = numberOrZero(raw.line_number);
    // test_id is the stable per-check token (e.g. "B608"); it becomes
    // the citation token an agent cites as "bandit:B608".
    const testId = typeof raw.test_id === "string" && raw.test_id ? raw.test_id : "bandit";
    if (!filePath || line <= 0) continue;
    const text = typeof raw.issue_text === "string" ? raw.issue_text : "";
    out.push({
      source: "bandit",
      ruleId: testId,
      filePath,
      lineStart: line,
      lineEnd: line,
      // Every bandit hit is a security finding; rank by its own severity.
      severity: normalizeBanditSeverity(raw.issue_severity),
      message: buildMessage(testId, text),
      reference: typeof raw.more_info === "string" && raw.more_info ? raw.more_info : null,
    });
  }
  return out;
}

// Bandit reports issue_severity as HIGH / MEDIUM / LOW. Map to our scale.
function normalizeBanditSeverity(raw: unknown): StaticFindingSeverity {
  if (typeof raw !== "string") return "medium";
  switch (raw.toUpperCase()) {
    case "HIGH":
      return "high";
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "medium";
  }
}

function buildMessage(testId: string, text: string): string {
  const full = text ? `${testId}: ${text}` : testId;
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
