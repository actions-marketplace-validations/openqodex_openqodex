// ShellCheck adapter (shell script lint). Runs `shellcheck -f json
// <files>` against the changed shell scripts in the working tree and
// normalizes the vendor JSON into StaticFinding[]. Catches the
// dangerous shell footguns: unquoted expansions (word-splitting /
// glob injection), unsafe `rm` patterns, `cd` without error handling,
// missing `set -e`, and command-substitution mistakes.
//
// We invoke it only on changed shell scripts, by extension (.sh, .bash) or,
// for a file with no extension, by its sh, bash, dash or ksh shebang (read
// by detect.ts), so a change without one is a no-op. ShellCheck emits
// a JSON array (one object per finding) with span lines and a per-finding
// level we map to our severity scale. It writes nothing to disk.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, runInChunks, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { RepoFacts } from "../detect.js";
import type { Adapter } from "./index.js";
import { suchAs } from "./words.js";

const SHELLCHECK_TIMEOUT_MS = 60_000;
const SHELLCHECK_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

function isShellPath(p: string): boolean {
  return /\.(sh|bash)$/i.test(p);
}

// .sh and .bash files, and extensionless scripts whose shebang names a shell
// shellcheck reads (bin/deploy with #!/usr/bin/env bash).
function shellScripts(changedPaths: string[], facts: RepoFacts): string[] {
  return safeFileArgs(changedPaths.filter((p) => isShellPath(p) || facts.content(p) === "shell"));
}

export async function runShellcheck(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
}): Promise<AdapterResult> {
  const scripts = shellScripts(args.changedPaths, args.facts);
  if (scripts.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  // -f json gives the array form (not json1's wrapped object);
  // --severity=style emits every level so our mapping decides what
  // matters, not shellcheck.
  const cliArgs = (files: string[]): string[] => ["-f", "json", "--severity=style", "--", ...files];

  // One process per chunk of files, so a whole-repo file list stays under
  // the argument limit; the findings of every chunk are merged.
  const tool = args.tool;
  try {
    const findings = await runInChunks("shellcheck", scripts, SHELLCHECK_TIMEOUT_MS, async (chunk, left) => {
      const stdout = await execShellcheck(tool, cliArgs(chunk), args.repoDir, left);
      try {
        return parseShellcheckJson(stdout);
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

async function execShellcheck(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: SHELLCHECK_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // ShellCheck exit codes: 0 = clean, 1 = findings present, 2 =
  // bad invocation / file not found, 3/4 = other usage errors.
  // We want stdout for both 0 and 1.
  const failed = describeFailure("shellcheck", result, SHELLCHECK_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode >= 2) {
    throw new Error(`shellcheck exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const shellcheck: Adapter = {
  source: "shellcheck",
  files: shellScripts,
  why: (files) => `shell scripts, ${suchAs(files)}`,
  run: (args) => runShellcheck(args),
};

type ShellcheckEntry = {
  file?: unknown;
  line?: unknown;
  endLine?: unknown;
  column?: unknown;
  level?: unknown;
  code?: unknown;
  message?: unknown;
};

export function parseShellcheckJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed as ShellcheckEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.file === "string" ? raw.file : "";
    const lineStart = numberOrZero(raw.line);
    const lineEnd = Math.max(lineStart, numberOrZero(raw.endLine) || lineStart);
    // ShellCheck codes are numeric (e.g. 2086). Stamp the conventional
    // "SC" prefix so the citation token matches the wiki / docs.
    const codeNum = numberOrZero(raw.code);
    const ruleId = codeNum > 0 ? `SC${codeNum}` : "shellcheck";
    const message = typeof raw.message === "string" ? raw.message : "";
    if (!filePath || lineStart <= 0) continue;
    out.push({
      source: "shellcheck",
      ruleId,
      filePath,
      lineStart,
      lineEnd,
      severity: normalizeShellcheckLevel(raw.level),
      message: trimMessage(message),
      reference: codeNum > 0 ? `https://www.shellcheck.net/wiki/SC${codeNum}` : null,
    });
  }
  return out;
}

// ShellCheck levels: error, warning, info, style. Map to our scale.
function normalizeShellcheckLevel(raw: unknown): StaticFindingSeverity {
  if (typeof raw !== "string") return "medium";
  switch (raw.toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    case "info":
      return "low";
    case "style":
      return "info";
    default:
      return "medium";
  }
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
