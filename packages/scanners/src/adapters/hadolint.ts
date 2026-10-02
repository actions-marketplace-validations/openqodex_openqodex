// hadolint adapter (Dockerfile lint). Runs `hadolint -f json <files>`
// against the changed Dockerfiles in the working tree and normalizes the
// vendor JSON into StaticFinding[]. Catches the classic Docker
// footguns: unpinned base images / apt packages, running as root, ADD
// instead of COPY, missing --no-install-recommends, secrets in build
// args, and the shellcheck issues hadolint runs against RUN steps.
//
// We invoke it only on changed files whose basename looks like a
// Dockerfile so a change without one is a no-op. hadolint emits a JSON
// array (one object per finding) with a per-finding level we map to our
// severity scale. It writes nothing to disk.
//
// All errors are captured into the result; the runner never throws on a
// scanner failure: static analysis is additive context, not a gate.

import path from "node:path";
import type {
  AdapterResult,
  ResolvedTool,
  ScannerSeverity as StaticFindingSeverity,
  StaticFinding,
} from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Adapter } from "./index.js";

const HADOLINT_TIMEOUT_MS = 60_000;
const HADOLINT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

// Match `Dockerfile`, `Dockerfile.prod`, `prod.Dockerfile`, `web.dockerfile`.
function isDockerfilePath(p: string): boolean {
  const base = path.basename(p);
  return /(^|\.)dockerfile$/i.test(base) || /^dockerfile(\.|$)/i.test(base);
}

export async function runHadolint(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
}): Promise<AdapterResult> {
  const dockerfiles = safeFileArgs(args.changedPaths.filter(isDockerfilePath));
  if (dockerfiles.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  const cliArgs = ["-f", "json", "--no-color", "--", ...dockerfiles];

  let stdout: string;
  try {
    stdout = await execHadolint(args.tool, cliArgs, args.repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }

  try {
    return { findings: parseHadolintJson(stdout), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: `parse: ${message.slice(0, 200)}` };
  }
}

async function execHadolint(tool: ResolvedTool, cliArgs: string[], cwd: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs: HADOLINT_TIMEOUT_MS,
    maxBytes: HADOLINT_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // hadolint exit codes: 0 = clean, 1 = findings present (default
  // failure threshold), > 1 = usage / fatal error. We want stdout
  // for both 0 and 1.
  const failed = describeFailure("hadolint", result, HADOLINT_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode > 1) {
    throw new Error(`hadolint exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const hadolint: Adapter = {
  source: "hadolint",
  wants: (changedPaths) => safeFileArgs(changedPaths.filter(isDockerfilePath)).length > 0,
  run: (args) => runHadolint(args),
};

type HadolintEntry = {
  file?: unknown;
  line?: unknown;
  column?: unknown;
  level?: unknown;
  code?: unknown;
  message?: unknown;
};

export function parseHadolintJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed as HadolintEntry[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.file === "string" ? raw.file : "";
    const line = numberOrZero(raw.line);
    const code = typeof raw.code === "string" && raw.code ? raw.code : "hadolint";
    const message = typeof raw.message === "string" ? raw.message : "";
    if (!filePath || line <= 0) continue;
    out.push({
      source: "hadolint",
      ruleId: code,
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: normalizeHadolintLevel(raw.level),
      message: trimMessage(message),
      reference: code.startsWith("DL")
        ? `https://github.com/hadolint/hadolint/wiki/${code}`
        : null,
    });
  }
  return out;
}

// hadolint levels: error, warning, info, style. Map to our scale.
function normalizeHadolintLevel(raw: unknown): StaticFindingSeverity {
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
