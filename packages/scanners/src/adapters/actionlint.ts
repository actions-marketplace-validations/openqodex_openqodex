// actionlint adapter (GitHub Actions workflow lint). Runs
// `actionlint -format '{{json .}}' <changed workflow files>` in the
// working tree and normalizes the vendor JSON into StaticFinding[].
// High signal for CI-heavy repos: catches invalid `${{ }}` expressions, untrusted-input injection in
// workflow expressions, deprecated runner images, and bad job/needs
// wiring that a generic linter never sees.
//
// We only invoke it on changed files under .github/workflows/*.{yml,yaml}
// so a change without workflows is a no-op. actionlint emits a JSON array
// via the Go template `{{json .}}`; each entry is line+column anchored.
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
import { describeFailure, execTool, runInChunks, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";
import { suchAs } from "./words.js";

const ACTIONLINT_TIMEOUT_MS = 60_000;
const ACTIONLINT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

// GitHub only runs workflow YAML directly under .github/workflows/.
// actionlint errors on non-workflow YAML, so restrict to that path.
function isWorkflowPath(p: string): boolean {
  return (
    /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(p)
  );
}

export async function runActionlint(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
}): Promise<AdapterResult> {
  const workflows = safeFileArgs(args.changedPaths.filter(isWorkflowPath));
  if (workflows.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  // -shellcheck= and -pyflakes= switch off the run: step checks that call
  // whatever shellcheck and pyflakes are on PATH, so two machines report
  // the same findings (flags checked against actionlint 1.7.7).
  const cliArgs = (files: string[]): string[] => ["-format", "{{json .}}", "-no-color", "-shellcheck=", "-pyflakes=", "--", ...files];

  // One process per chunk of files, so a whole-repo file list stays under
  // the argument limit; the findings of every chunk are merged.
  const tool = args.tool;
  try {
    const findings = await runInChunks("actionlint", workflows, ACTIONLINT_TIMEOUT_MS, async (chunk, left) => {
      const stdout = await execActionlint(tool, cliArgs(chunk), args.repoDir, left);
      try {
        return parseActionlintJson(stdout);
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

async function execActionlint(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: ACTIONLINT_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // actionlint exit codes: 0 = no problems, 1 = problems found,
  // 2 = command-line / fatal error. We want stdout for 0 and 1.
  const failed = describeFailure("actionlint", result, ACTIONLINT_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode >= 2) {
    throw new Error(`actionlint exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const actionlint: Adapter = {
  source: "actionlint",
  files: (changedPaths) => safeFileArgs(changedPaths.filter(isWorkflowPath)),
  why: (files) => `GitHub workflow files, ${suchAs(files)}`,
  run: (args) => runActionlint(args),
};

type ActionlintEntry = {
  message?: unknown;
  filepath?: unknown;
  line?: unknown;
  column?: unknown;
  kind?: unknown;
};

export function parseActionlintJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed as ActionlintEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.filepath === "string" ? raw.filepath : "";
    const line = numberOrZero(raw.line);
    const kind = typeof raw.kind === "string" && raw.kind ? raw.kind : "actionlint";
    const message = typeof raw.message === "string" ? raw.message : "";
    if (!filePath || line <= 0) continue;
    out.push({
      source: "actionlint",
      ruleId: kind,
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: severityForKind(kind),
      message: trimMessage(message),
      reference: "https://github.com/rhysd/actionlint/blob/main/docs/checks.md",
    });
  }
  return out;
}

// actionlint has no severity field; every entry is an error in its model.
// Bump security-relevant rule kinds (expression injection, embedded
// shellcheck issues in run: steps, credential exposure) to high; treat
// the rest as medium.
function severityForKind(kind: string): StaticFindingSeverity {
  const k = kind.toLowerCase();
  if (k === "expression" || k === "shellcheck" || k === "credentials" || k === "permissions") {
    return "high";
  }
  return "medium";
}

function numberOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  return 0;
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
