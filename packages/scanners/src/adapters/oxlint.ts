// oxlint adapter (JS / TS lint). Runs `oxlint --format=json <files>`
// against the changed JavaScript / TypeScript files in the working tree
// and normalizes the vendor JSON `diagnostics[]` into StaticFinding[].
// oxlint is a single self-contained binary that needs no repo config
// and no installed node_modules: out of the box it runs its
// `correctness` rule set (ESLint-rule-compatible: no-cond-assign,
// no-unused-vars, no-debugger, no-constant-condition, the
// always-a-bug class). That makes it the right zero-setup linter for
// the ensemble where a repo's own ESLint may not be runnable. It does
// still honor an `.oxlintrc.json` if the repo ships one.
//
// We invoke it only on changed .js/.jsx/.ts/.tsx/.mjs/.cjs/.cts/.mts
// files so a change without them is a no-op. oxlint emits one JSON object
// with a diagnostics[] array; each diagnostic's location lives on the first
// label's span. Findings are anchored to changed lines downstream
// (filterToChangedLines). It writes nothing to disk.
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

const OXLINT_TIMEOUT_MS = 60_000;
const OXLINT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

// Extensions oxlint lints: .js .jsx .ts .tsx .mjs .cjs .mts .cts.
function isJsTsPath(p: string): boolean {
  return /\.(jsx?|tsx?|[cm][jt]s)$/i.test(p);
}

export async function runOxlint(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
}): Promise<AdapterResult> {
  const jsFiles = safeFileArgs(args.changedPaths.filter(isJsTsPath));
  if (jsFiles.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };

  // --format=json: the stable machine shape. Changed files are passed
  // positionally so it lints only those.
  const cliArgs = ["--format=json", "--", ...jsFiles];

  let stdout: string;
  try {
    stdout = await execOxlint(args.tool, cliArgs, args.repoDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }

  try {
    return { findings: parseOxlintJson(stdout), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: `parse: ${message.slice(0, 200)}` };
  }
}

async function execOxlint(tool: ResolvedTool, cliArgs: string[], cwd: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs: OXLINT_TIMEOUT_MS,
    maxBytes: OXLINT_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // oxlint exit codes: 0 = no deny-level errors (warnings still
  // possible), 1 = lint errors / max-warnings exceeded, higher =
  // usage error. It writes the JSON object to stdout for both 0
  // and 1. Prefer stdout whenever present; only a missing binary
  // or an empty-output failure is fatal.
  const failed = describeFailure("oxlint", result, OXLINT_TIMEOUT_MS);
  if (result.failure === "not_found" && failed) throw new Error(failed);
  if (result.stdout.trim()) return result.stdout;
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(`oxlint exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const oxlint: Adapter = {
  source: "oxlint",
  wants: (changedPaths) => safeFileArgs(changedPaths.filter(isJsTsPath)).length > 0,
  run: (args) => runOxlint(args),
};

type OxlintLabel = {
  span?: { line?: unknown };
};

type OxlintDiagnostic = {
  message?: unknown;
  code?: unknown;
  severity?: unknown;
  url?: unknown;
  filename?: unknown;
  labels?: unknown;
};

export function parseOxlintJson(json: string): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { diagnostics?: unknown };
  if (!parsed || !Array.isArray(parsed.diagnostics)) return [];
  const out: StaticFinding[] = [];
  for (const raw of parsed.diagnostics as OxlintDiagnostic[]) {
    if (!raw || typeof raw !== "object") continue;
    const filePath = typeof raw.filename === "string" ? raw.filename : "";
    const line = firstLabelLine(raw.labels);
    if (!filePath || line <= 0) continue;
    // oxlint codes look like "eslint(no-debugger)"; normalize to
    // "eslint/no-debugger" so the citation token reads
    // "oxlint:eslint/no-debugger".
    const code = typeof raw.code === "string" && raw.code ? raw.code : "oxlint";
    const ruleId = normalizeCode(code);
    const message = typeof raw.message === "string" ? raw.message : "";
    out.push({
      source: "oxlint",
      ruleId,
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: severityForRule(ruleId),
      message: buildMessage(ruleId, message),
      reference: typeof raw.url === "string" && raw.url ? raw.url : null,
    });
  }
  return out;
}

// oxlint puts the diagnostic location on the first label's span; take
// the first label that carries a usable line.
function firstLabelLine(labels: unknown): number {
  if (!Array.isArray(labels)) return 0;
  for (const l of labels as OxlintLabel[]) {
    if (l && typeof l === "object") {
      const line = numberOrZero(l.span?.line);
      if (line > 0) return line;
    }
  }
  return 0;
}

function normalizeCode(code: string): string {
  const m = /^([^()]+)\(([^()]+)\)$/.exec(code.trim());
  return m ? `${m[1]}/${m[2]}` : code;
}

// oxlint's JSON omits the rule's category, so derive it from the rule
// id. oxlint runs only its `correctness` (bug) category by default, so
// the common case is a real-bug finding; a repo that opts extra
// categories in via .oxlintrc.json can surface security or style rules,
// which we rank up / down accordingly.
function categoryForRule(ruleId: string): "security" | "style" | "bug" {
  const id = ruleId.toLowerCase();
  if (id.startsWith("security/") || /\b(eval|injection|xss|csrf|unsafe|dangerously|crypto)\b/.test(id)) {
    return "security";
  }
  if (/^(prettier|stylistic)\//.test(id) || /(indent|spacing|quotes|semicolon|padding|newline)/.test(id)) {
    return "style";
  }
  return "bug";
}

// security is the high-value class; correctness/bug rules are the
// medium bug class (rubocop's Lint cops sit here too); style /
// formatting is info noise the cap sheds first.
function severityForRule(ruleId: string): StaticFindingSeverity {
  switch (categoryForRule(ruleId)) {
    case "security":
      return "high";
    case "style":
      return "info";
    default:
      return "medium";
  }
}

function buildMessage(ruleId: string, message: string): string {
  const full = message ? `${ruleId}: ${message}` : ruleId;
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
