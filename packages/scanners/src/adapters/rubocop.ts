// RuboCop adapter (Ruby lint). Runs `rubocop --config <owned> --format json
// --force-exclusion --cache false <changed ruby files>` from a temp folder
// and normalizes the vendor JSON `files[].offenses[]` into StaticFinding[].
// Covers the Ruby rule space the rest of the ensemble misses: Lint
// real-bug cops (useless assignments, shadowed exceptions, ambiguous
// blocks), Security cops (eval, Marshal.load, open with interpolation),
// and Performance cops.
//
// We invoke it only on changed Ruby source files so a change without Ruby
// is a no-op. The repo's own .rubocop.yml is never loaded (it can run
// code), so only Lint / Security / Performance offenses are emitted,
// skipping the Style / Layout opinions nobody opted into.
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
import { describeFailure, execTool, runInChunks, stderrTail } from "../exec.js";
import type { Adapter } from "./index.js";
import { withOwnedConfig } from "./owned-config.js";

const RUBOCOP_TIMEOUT_MS = 60_000;
const RUBOCOP_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

// Departments worth surfacing when the repo ships no rubocop config:
// the bug / security / performance cops, never the Style / Layout
// formatting opinions a team has to explicitly opt into.
const DEFAULT_DEPARTMENTS = new Set(["Lint", "Security", "Performance"]);

// Files rubocop lints natively: .rb / .rake / .gemspec sources plus the
// conventional extensionless Gemfile / Rakefile. We deliberately skip
// .erb (needs erb_lint, not rubocop).
function isRubyLintPath(p: string): boolean {
  if (/\.(rb|rake|gemspec)$/i.test(p)) return true;
  const base = path.basename(p);
  return base === "Gemfile" || base === "Rakefile";
}

// OpenQodex's own rubocop config: the default cops plus the Rails and
// Performance cops the toolchain installs. Passed with --config, so no repo
// config (nested ones included) is loaded: a repo's .rubocop.yml can
// `require` Ruby files and run ERB, which is code from the change running on
// the developer's machine.
const OWNED_CONFIG = [
  "require:",
  "  - rubocop-rails",
  "  - rubocop-performance",
  "AllCops:",
  "  NewCops: disable",
  "  SuggestExtensions: false",
  "",
].join("\n");

export async function runRubocop(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
}): Promise<AdapterResult> {
  const rubyFiles = args.changedPaths.filter(isRubyLintPath);
  if (rubyFiles.length === 0) return { findings: [], error: null };
  if (!args.tool) return { findings: [], error: "not installed" };
  const tool = args.tool;

  try {
    return await withOwnedConfig("rubocop.yml", OWNED_CONFIG, async (configPath, configDir) => {
      // rubocop also reads extra command-line arguments from a `.rubocop`
      // file in its working folder, so it runs from the temp folder, never
      // the repo, and gets absolute paths. --format json: stable machine
      // shape. --force-exclusion: honor the owned config's Exclude even for
      // files passed positionally. --cache false: no result cache written.
      // One process per chunk of files, so a whole-repo file list stays
      // under the argument limit; the findings of every chunk are merged.
      const targets = rubyFiles.map((rel) => path.join(args.repoDir, rel));
      const findings = await runInChunks("rubocop", targets, RUBOCOP_TIMEOUT_MS, async (chunk, left) => {
        const cliArgs = ["--config", configPath, "--format", "json", "--force-exclusion", "--cache", "false", "--", ...chunk];
        const stdout = await execRubocop(tool, cliArgs, configDir, left);
        try {
          // The owned config is not a team's opt-in to every cop, so only the
          // bug, security and performance departments are kept.
          return parseRubocopJson(stdout, { hasConfig: false });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`parse: ${message.slice(0, 200)}`);
        }
      });
      return { findings, error: null };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

async function execRubocop(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    maxBytes: RUBOCOP_OUTPUT_MAX_BYTES,
    env: tool.env,
  });
  // RuboCop exit codes: 0 = clean, 1 = offenses found, 2 = error
  // (bad config / args). We want stdout for both 0 and 1.
  const failed = describeFailure("rubocop", result, RUBOCOP_TIMEOUT_MS);
  if (failed) throw new Error(failed);
  if (result.exitCode !== null && result.exitCode >= 2) {
    throw new Error(`rubocop exit ${result.exitCode}: ${stderrTail(result)}`);
  }
  return result.stdout;
}

export const rubocop: Adapter = {
  source: "rubocop",
  wants: (changedPaths) => changedPaths.some(isRubyLintPath),
  run: (args) => runRubocop(args),
};

type RubocopOffense = {
  cop_name?: unknown;
  message?: unknown;
  location?: { start_line?: unknown; last_line?: unknown; line?: unknown };
};

type RubocopFile = {
  path?: unknown;
  offenses?: unknown;
};

export type ParseRubocopOptions = {
  // True when the repo ships its own .rubocop.yml: emit every offense
  // rubocop reports. False: restrict to bug / security / performance
  // departments so we don't flood the review with unopted style noise.
  hasConfig: boolean;
};

export function parseRubocopJson(json: string, opts: ParseRubocopOptions): StaticFinding[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as { files?: unknown };
  if (!parsed || !Array.isArray(parsed.files)) return [];
  const out: StaticFinding[] = [];
  for (const file of parsed.files as RubocopFile[]) {
    if (!file || typeof file !== "object") continue;
    const filePath = typeof file.path === "string" ? file.path : "";
    if (!filePath || !Array.isArray(file.offenses)) continue;
    for (const raw of file.offenses as RubocopOffense[]) {
      if (!raw || typeof raw !== "object") continue;
      const copName = typeof raw.cop_name === "string" && raw.cop_name ? raw.cop_name : "rubocop";
      const department = copName.includes("/") ? copName.slice(0, copName.indexOf("/")) : "";
      if (!opts.hasConfig && !DEFAULT_DEPARTMENTS.has(department)) continue;
      const lineStart = numberOrZero(raw.location?.start_line) || numberOrZero(raw.location?.line);
      const lineEnd = Math.max(lineStart, numberOrZero(raw.location?.last_line) || lineStart);
      if (lineStart <= 0) continue;
      const message = typeof raw.message === "string" ? raw.message : "";
      out.push({
        source: "rubocop",
        ruleId: copName,
        filePath,
        lineStart,
        lineEnd,
        severity: severityForDepartment(department),
        message: buildMessage(copName, message),
        reference: null,
      });
    }
  }
  return out;
}

// Map the cop department to our severity scale: Security is the
// high-value class, Lint catches real bugs, Performance is low-noise
// advisory, and Style / Layout (or anything else) is formatting info.
function severityForDepartment(department: string): StaticFindingSeverity {
  switch (department) {
    case "Security":
      return "high";
    case "Lint":
      return "medium";
    case "Performance":
      return "low";
    case "Style":
    case "Layout":
      return "info";
    default:
      return "low";
  }
}

function buildMessage(copName: string, message: string): string {
  const full = message ? `${copName}: ${message}` : copName;
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
