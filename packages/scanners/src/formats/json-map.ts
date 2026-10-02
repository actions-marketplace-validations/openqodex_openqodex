// Reads any JSON report through a `map` block of dotted paths, for scanners
// that cannot write SARIF. Dotted keys and `[n]` indexes only: no JSONPath,
// no wildcards, no expressions.
import type { JsonMap, ScannerSeverity, ScannerSource, StaticFinding } from "@openqodex/core";
import { MAX_SPAN_LINES, toRepoPath } from "./sarif.js";

type Step = string | number;

const SEGMENT = /^([^[\]]+)?((?:\[\d+\])*)$/;

function compile(path: string): Step[] {
  if (path === ".") return [];
  const steps: Step[] = [];
  for (const segment of path.split(".")) {
    const m = SEGMENT.exec(segment);
    if (!m || (!m[1] && !m[2])) throw new Error(`json-map path "${path}" is not a dotted path with [n] indexes`);
    if (m[1]) steps.push(m[1]);
    for (const index of m[2]?.match(/\d+/g) ?? []) steps.push(Number(index));
  }
  return steps;
}

function read(value: unknown, steps: Step[]): unknown {
  let cur = value;
  for (const step of steps) {
    if (typeof step === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[step];
    } else {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[step];
    }
  }
  return cur;
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;

function line(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export function parseJsonMap(json: string, map: JsonMap, opts: { repoDir: string; source: ScannerSource }): StaticFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("report is not valid JSON");
  }
  const at = {
    items: compile(map.items),
    file: compile(map.file),
    line: compile(map.line),
    endLine: map.end_line ? compile(map.end_line) : null,
    rule: compile(map.rule),
    severity: map.severity ? compile(map.severity) : null,
    message: compile(map.message),
    reference: map.reference ? compile(map.reference) : null,
  };

  const items = read(doc, at.items);
  // A tool that found nothing may leave the list out.
  if (items === undefined || items === null) return [];
  if (!Array.isArray(items)) throw new Error(`json-map items path "${map.items}" is not an array in the report`);

  const findings: StaticFinding[] = [];
  for (const item of items) {
    const file = text(read(item, at.file));
    const lineStart = line(read(item, at.line));
    if (!file || !lineStart) continue;
    const filePath = toRepoPath(file, opts.repoDir);
    if (!filePath) continue;
    const rawEnd = at.endLine ? read(item, at.endLine) : undefined;
    if (rawEnd !== undefined && rawEnd !== null && line(rawEnd) === null) continue;
    const lineEnd = Math.max(lineStart, line(rawEnd) ?? lineStart);
    if (lineEnd - lineStart + 1 > MAX_SPAN_LINES) continue;
    const ruleId = text(read(item, at.rule)) ?? "unknown";
    const rawSeverity = at.severity ? text(read(item, at.severity)) : null;
    const severity: ScannerSeverity =
      rawSeverity !== null && Object.hasOwn(map.severity_map, rawSeverity) ? map.severity_map[rawSeverity]! : "medium";
    findings.push({
      source: opts.source,
      ruleId,
      filePath,
      lineStart,
      lineEnd,
      severity,
      message: text(read(item, at.message)) ?? ruleId,
      reference: at.reference ? text(read(item, at.reference)) : null,
    });
  }
  return findings;
}
