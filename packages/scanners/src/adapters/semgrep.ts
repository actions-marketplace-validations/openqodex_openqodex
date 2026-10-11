// Semgrep adapter. Runs `semgrep scan` against the developer's working tree
// with three rule packs (default, security-audit, secrets) and normalizes the
// vendor JSON into StaticFinding[]. Every error is captured into the result;
// the runner never throws on a scanner failure: static analysis is additive
// context, not a gate.
//
// The rule packs are fetched from the Semgrep registry at run time onto the
// developer's machine and never bundled. Semgrep keeps its settings and logs
// under ~/.semgrep, outside the repo, and writes nothing into the working tree.
// Its temp files go to a folder of its own, removed after the scan. The scan's
// summary names each pack it consumed by the sha256 of its rules (rulePackHash)
// and the size of the bytes semgrep read, taken from that folder before it is
// removed.
//
// The packs' framework rule families fire on other frameworks' apps (on a
// Flask app, django's rules raise the SQL injection flask's own rule raises
// on the same line). Leaving a family out by framework was measured and
// rejected (benchmark/index/ledger/scanner.jsonl, SC-0002): what it removes
// are true findings, and on Fastify, Next.js, Sinatra and FastAPI apps a
// sister framework's family is the only one that finds some bugs.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AdapterResult, ResolvedTool, RulePack, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool, runInChunks, isOffline, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import type { Scratch } from "../scratch.js";
import type { Adapter } from "./index.js";

const SEMGREP_TIMEOUT_MS = 60_000;
// Per-rule timeout. Semgrep's --timeout flag caps a single rule's
// run against a single file. With many files and many rules, the
// per-file budget is still bounded by SEMGREP_TIMEOUT_MS above.
const SEMGREP_PER_RULE_TIMEOUT_SEC = 30;
// semgrep skips a larger file, so a suppression comment in one hides nothing.
export const SEMGREP_MAX_TARGET_BYTES = 1_000_000;
const SEMGREP_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

const RULE_PACKS = ["p/default", "p/security-audit", "p/secrets"];

// Semgrep asks semgrep.dev for the latest version on every run unless told
// not to; the rule packs are the only network use allowed. Both the variable
// and --disable-version-check are checked against semgrep 1.94.0.
const SEMGREP_ENV = { SEMGREP_ENABLE_VERSION_CHECK: "0" };

export const SEMGREP_OFFLINE_REASON = "offline, the rule packs need the network";

// Known before any tool is resolved, so an offline run never installs or
// starts semgrep (it would fetch the registry rule packs).
function offlineReason(): string | null {
  return isOffline() ? SEMGREP_OFFLINE_REASON : null;
}

export type SemgrepRunArgs = {
  repoDir: string;
  // Paths (relative to repoDir) to lint. We pass them as positional
  // args so semgrep only scans changed files, not the whole repo.
  changedPaths: string[];
  tool: ResolvedTool | null;
  scratch: Scratch;
};

export async function runSemgrep(args: SemgrepRunArgs): Promise<AdapterResult> {
  // Drop flag-shaped paths (argv smuggling via a file named, say,
  // "--config=https://attacker/rules.yaml", which would make semgrep load
  // remote rules); the "--" terminator below is defense in depth.
  const targets = safeFileArgs(args.changedPaths);
  if (targets.length === 0) return { findings: [], error: null };
  const skipped = offlineReason();
  if (skipped) return { findings: [], error: null, skipped };
  if (!args.tool) return { findings: [], error: "not installed" };

  const cliArgs = (files: string[]): string[] => [
    "scan",
    ...RULE_PACKS.flatMap((p) => ["--config", p]),
    "--json",
    "--quiet",
    "--metrics",
    "off",
    "--disable-version-check",
    "--no-git-ignore",
    "--timeout",
    String(SEMGREP_PER_RULE_TIMEOUT_SEC),
    "--max-target-bytes",
    String(SEMGREP_MAX_TARGET_BYTES),
    "--",
    ...files,
  ];

  // Semgrep writes each rule pack to its temp folder as semgrep-*.rules and
  // never removes them, about 2.7 MB a scan. It gets a folder of its own,
  // which mkdtemp makes readable by this user only, removed after the scan
  // whatever the exit. The packs each process consumed are read from it
  // first (consumedPacks).
  let tmp: string;
  try {
    tmp = await fs.mkdtemp(path.join(args.scratch.temp, "openqodex-semgrep-"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: `mkdtemp: ${message.slice(0, 200)}` };
  }

  // One process per chunk of files, so a whole-repo file list stays under
  // the argument limit; the findings of every chunk are merged. Each process
  // fetches the packs again, so the record holds every version a chunk
  // consumed, and is left out once one chunk's packs cannot be told apart.
  const tool = args.tool;
  const rules: RulePack[] = [];
  const seen = new Set<string>();
  let rulesKnown = true;
  try {
    const findings = await runInChunks("semgrep", targets, SEMGREP_TIMEOUT_MS, async (chunk, left) => {
      const stdout = await execSemgrep(tool, cliArgs(chunk), args.repoDir, left, tmp);
      const packs = await consumedPacks(tmp, seen);
      if (packs === null) rulesKnown = false;
      else for (const p of packs) if (!rules.some((r) => r.pack === p.pack && r.sha256 === p.sha256)) rules.push(p);
      try {
        return parseSemgrepJson(stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`parse: ${message.slice(0, 200)}`);
      }
    });
    return { findings, error: null, ...(rulesKnown ? { rules } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

// The packs one semgrep process consumed, from the files it wrote that `seen`
// does not hold yet. semgrep 1.94.0 fetches the --config packs one after
// another in the order given, and writes each, as the text it then parses,
// to a new semgrep-<random>.rules file before it fetches the next
// (config_resolver.py: Config.from_config_list, parse_config_string). So
// those files, oldest first, are RULE_PACKS in order. Null when they cannot
// be told apart (not one file per pack, two written at the same instant),
// or one cannot be read or is not a rule pack.
async function consumedPacks(tmp: string, seen: Set<string>): Promise<RulePack[] | null> {
  try {
    const names = (await fs.readdir(tmp)).filter((n) => n.startsWith("semgrep-") && n.endsWith(".rules") && !seen.has(n));
    for (const n of names) seen.add(n);
    if (names.length !== RULE_PACKS.length) return null;
    const files = await Promise.all(
      names.map(async (name) => {
        const file = path.join(tmp, name);
        const [stat, bytes] = await Promise.all([fs.stat(file, { bigint: true }), fs.readFile(file)]);
        return { written: stat.mtimeNs, sha256: rulePackHash(bytes), bytes: bytes.length };
      }),
    );
    files.sort((a, b) => (a.written < b.written ? -1 : a.written > b.written ? 1 : 0));
    if (files.some((f, i) => i > 0 && f.written === files[i - 1]!.written)) return null;
    if (files.some((f) => f.sha256 === null)) return null;
    return files.map((f, i) => ({ pack: RULE_PACKS[i]!, sha256: f.sha256!, bytes: f.bytes }));
  } catch {
    return null;
  }
}

// The sha256 of a registry pack's rules, the same for every byte form the
// registry serves one rule set in. semgrep saves the response body as it
// came. The registry lists the same rules in another order from one origin
// response to the next (two CloudFront edges served p/default on 2026-10-11
// at one size with other bytes and another weak ETag, and only the order of
// the rules differed), and an edge can serve the YAML form, because the
// cache key ignores the Accept header semgrep sends.
//
// The normal form: the text is read as JSON, or as YAML when it is not
// JSON, with every number read as a JavaScript number (so an integer above
// 2^53 loses precision); only its `rules` array is kept (the JSON form's
// `missed`, a count of the rules this caller is not given, is dropped, as is
// any other top-level key); the rules are sorted by `id` in plain character
// order (by UTF-16 code unit, as JavaScript compares strings), and two rules
// with one id by their own normal-form text, compared the same way; every
// object's keys are sorted the same way, at every depth; arrays inside a
// rule keep their order; and it is written as JSON with no whitespace:
// {"rules":[...]}. The sha256 is of that text in UTF-8. Null when the text
// is not a rule pack (readRulePack).
export function rulePackHash(content: Buffer | string): string | null {
  const rules = readRulePack(content);
  if (rules === null) return null;
  const sorted = rules
    .map((rule) => ({ id: rule.id, text: normalJson(rule) }))
    .sort((a, b) => byText(a.id, b.id) || byText(a.text, b.text));
  const normal = `{"rules":[${sorted.map((r) => r.text).join(",")}]}`;
  return createHash("sha256").update(normal, "utf8").digest("hex");
}

export type PackRule = Record<string, unknown> & { id: string };

// The rules of a registry pack, in the order the text lists them. Null when
// the text is not a rule pack: neither JSON nor YAML, not a mapping with a
// `rules` array, or an entry of that array that is not a mapping with a
// string `id`.
export function readRulePack(content: Buffer | string): PackRule[] | null {
  const text = typeof content === "string" ? content : content.toString("utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      // "error": a parse error still throws, and a warning prints nothing.
      doc = parseYaml(text, { logLevel: "error" });
    } catch {
      return null;
    }
  }
  if (!isMapping(doc)) return null;
  const rules = doc.rules;
  if (!Array.isArray(rules)) return null;
  if (!rules.every((rule) => isMapping(rule) && typeof rule.id === "string")) return null;
  return rules as PackRule[];
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// JSON with every object's keys sorted, at every depth, and no whitespace.
function normalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort(byText);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${normalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function execSemgrep(tool: ResolvedTool, cliArgs: string[], cwd: string, timeoutMs: number, tmp: string): Promise<string> {
  const result = await execTool(tool.path, cliArgs, {
    cwd,
    timeoutMs,
    // Semgrep prints findings as a single JSON blob on stdout; on
    // a large change with many matches the buffer must accommodate it.
    maxBytes: SEMGREP_OUTPUT_MAX_BYTES,
    env: { ...tool.env, ...SEMGREP_ENV, TMPDIR: tmp },
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
  files: (changedPaths) => safeFileArgs(changedPaths),
  why: () => "any file",
  skip: offlineReason,
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
