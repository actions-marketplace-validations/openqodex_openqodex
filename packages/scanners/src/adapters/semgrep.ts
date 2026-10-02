// Semgrep adapter. Runs `semgrep scan` against the developer's working tree
// with three rule packs (default, security-audit, secrets) and normalizes the
// vendor JSON into StaticFinding[]. Every error is captured into the result;
// the runner never throws on a scanner failure: static analysis is additive
// context, not a gate.
//
// The rule packs are fetched from the Semgrep registry at run time onto the
// developer's machine and never bundled. Semgrep keeps its settings and logs
// under ~/.semgrep, outside the repo, and writes nothing into the working tree.

import type { AdapterResult, ResolvedTool, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";

const SEMGREP_TIMEOUT_MS = 60_000;
// Per-rule timeout. Semgrep's --timeout flag caps a single rule's
// run against a single file. With many files and many rules, the
// per-file budget is still bounded by SEMGREP_TIMEOUT_MS above.
const SEMGREP_PER_RULE_TIMEOUT_SEC = 30;
const SEMGREP_MAX_TARGET_BYTES = 1_000_000;
const SEMGREP_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

const RULE_PACKS = ["p/default", "p/security-audit", "p/secrets"];

// Semgrep asks semgrep.dev for the latest version on every run unless told
// not to; the rule packs are the only network use allowed.
const SEMGREP_ENV = { SEMGREP_ENABLE_VERSION_CHECK: "0" };

export type SemgrepRunArgs = {
  repoDir: string;
  // Paths (relative to repoDir) to lint. We pass them as positional
  // args so semgrep only scans changed files, not the whole repo.
  changedPaths: string[];
  tool: ResolvedTool | null;
};

export async function runSemgrep(args: SemgrepRunArgs): Promise<AdapterResult> {
  // Drop flag-shaped paths (argv smuggling via a file named, say,
  // "--config=https://attacker/rules.yaml", which would make semgrep load
  // remote rules); the "--" terminator below is defense in depth.
  const targets = safeFileArgs(args.changedPaths);
  if (targets.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const cliArgs = [
    "scan",
    ...RULE_PACKS.flatMap((p) => ["--config", p]),
    "--json",
    "--quiet",
    "--metrics",
    "off",
    "--no-git-ignore",
    "--timeout",
    String(SEMGREP_PER_RULE_TIMEOUT_SEC),
    "--max-target-bytes",
    String(SEMGREP_MAX_TARGET_BYTES),
    "--",
    ...targets,
  ];

  let stdout: string;
  try {
    stdout = await execSemgrep(args.tool, cliArgs, args.repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }

  try {
    return { findings: parseSemgrepJson(stdout), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: `parse: ${message.slice(0, 200)}` };
  }
}

async function execSemgrep(tool: ResolvedTool, cliArgs: string[], cwd: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs: SEMGREP_TIMEOUT_MS,
    // Semgrep prints findings as a single JSON blob on stdout; on
    // a large change with many matches the buffer must accommodate it.
    maxBytes: SEMGREP_OUTPUT_MAX_BYTES,
    env: { ...tool.env, ...SEMGREP_ENV },
  });
  const failed = describeFailure("semgrep", result, SEMGREP_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  // Semgrep exit codes: 0 = clean, 1 = findings present, 2 =
  // error. We want stdout for both 0 and 1; only treat 2+ as a
  // real failure.
  if (result.exitCode !== null && result.exitCode >= 2) {
    throw new Error(`semgrep exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const semgrep: Adapter = {
  source: "semgrep",
  wants: (changedPaths) => safeFileArgs(changedPaths).length > 0,
  run: (args) => runSemgrep(args),
};

type SemgrepResult = {
  check_id?: unknown;
  path?: unknown;
  start?: { line?: unknown };
  end?: { line?: unknown };
  extra?: {
    severity?: unknown;
    message?: unknown;
    metadata?: { references?: unknown };
  };
};

export function parseSemgrepJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { results?: unknown };
  if (!parsed || !Array.isArray(parsed.results)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed.results as SemgrepResult[]) {
    if (!raw || typeof raw !== "object") continue;
    const ruleId = typeof raw.check_id === "string" ? raw.check_id : "";
    const filePath = typeof raw.path === "string" ? raw.path : "";
    const lineStart = numberOrZero(raw.start?.line);
    const lineEnd = Math.max(lineStart, numberOrZero(raw.end?.line) || lineStart);
    const message = typeof raw.extra?.message === "string" ? raw.extra.message : "";
    if (!ruleId || !filePath || lineStart <= 0) continue;
    out.push({
      source: "semgrep",
      ruleId,
      filePath,
      lineStart,
      lineEnd,
      severity: normalizeSemgrepSeverity(raw.extra?.severity),
      message: trimMessage(message),
      reference: firstReference(raw.extra?.metadata?.references),
    });
  }
  return out;
}

function normalizeSemgrepSeverity(raw: unknown) {
  if (typeof raw !== "string") return "medium" as const;
  const v = raw.toUpperCase();
  if (v === "ERROR") return "high" as const;
  if (v === "WARNING") return "medium" as const;
  if (v === "INFO") return "info" as const;
  return "medium" as const;
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  // One paragraph, single line. Strip newlines and cap.
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}

function firstReference(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const first = v[0];
  return typeof first === "string" ? first : null;
}
