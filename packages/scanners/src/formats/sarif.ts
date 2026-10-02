// Reads a SARIF 2.1.0 log (the format most scanners can write) into findings.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScannerSeverity, ScannerSource, StaticFinding } from "@openqodex/core";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const get = (v: unknown, ...keys: string[]): unknown => {
  let cur = v;
  for (const key of keys) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
};

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // The file may not exist (deleted, generated); its folder usually does.
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

function inside(repoDir: string, absPath: string): string | null {
  const rel = relative(repoDir, absPath);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join("/");
}

// A scanner's path, absolute or relative to the repo, as a repo-relative path
// with forward slashes. Null when it is outside the repo. Tries the real path
// of both sides too, because macOS temp folders are reached through symlinks.
export function toRepoPath(path: string, repoDir: string): string | null {
  const abs = resolve(repoDir, path);
  return inside(repoDir, abs) ?? inside(realOrSelf(repoDir), realOrSelf(abs));
}

const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

// Joins an artifact uri with its uriBaseId chain, then turns it into a path.
// Null for a uri that is not a file (http, a missing value).
function artifactPath(location: unknown, bases: unknown): string | null {
  let uri = str(get(location, "uri"));
  if (!uri) return null;
  let baseId = str(get(location, "uriBaseId"));
  for (let depth = 0; baseId && depth < 8 && !SCHEME.test(uri) && !uri.startsWith("/"); depth++) {
    const base = get(bases, baseId);
    const baseUri = str(get(base, "uri"));
    if (!baseUri) break;
    uri = baseUri.endsWith("/") ? baseUri + uri : `${baseUri}/${uri}`;
    baseId = str(get(base, "uriBaseId"));
  }
  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(new URL(uri));
    } catch {
      return null;
    }
  }
  if (SCHEME.test(uri)) return null;
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

function fromSecuritySeverity(v: unknown): ScannerSeverity | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  if (n > 0) return "low";
  return "info";
}

const LEVELS: Record<string, ScannerSeverity> = { error: "high", warning: "medium", note: "low", none: "info" };

function severityOf(result: Obj, rule: Obj | null): ScannerSeverity {
  return (
    fromSecuritySeverity(get(result, "properties", "security-severity")) ??
    fromSecuritySeverity(get(rule, "properties", "security-severity")) ??
    LEVELS[str(result.level) ?? ""] ??
    LEVELS[str(get(rule, "defaultConfiguration", "level")) ?? ""] ??
    "medium"
  );
}

const positiveInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null);

export function parseSarif(json: string, opts: { repoDir: string; source: ScannerSource }): StaticFinding[] {
  let log: unknown;
  try {
    log = JSON.parse(json);
  } catch {
    throw new Error("report is not valid JSON");
  }
  const runs = get(log, "runs");
  if (!Array.isArray(runs)) throw new Error("report is not a SARIF log: no runs array");

  const findings: StaticFinding[] = [];
  for (const run of runs) {
    const driverRules = get(run, "tool", "driver", "rules");
    const rules: Obj[] = Array.isArray(driverRules) ? driverRules.filter(isObj) : [];
    const byId = new Map<string, Obj>();
    for (const rule of rules) {
      const id = str(rule.id);
      if (id && !byId.has(id)) byId.set(id, rule);
    }
    const bases = get(run, "originalUriBaseIds");
    const results = get(run, "results");
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      if (!isObj(result)) continue;
      const index = result.ruleIndex ?? get(result, "rule", "index");
      const id = str(result.ruleId) ?? str(get(result, "rule", "id"));
      const rule = (typeof index === "number" ? rules[index] : undefined) ?? (id ? byId.get(id) : undefined) ?? null;
      const ruleId = id ?? str(get(rule, "id")) ?? "unknown";

      const loc = Array.isArray(result.locations) ? get(result.locations[0], "physicalLocation") : undefined;
      const path = artifactPath(get(loc, "artifactLocation"), bases);
      if (!path) continue;
      const filePath = toRepoPath(path, opts.repoDir);
      if (!filePath) continue;
      const lineStart = positiveInt(get(loc, "region", "startLine"));
      if (!lineStart) continue;
      const lineEnd = Math.max(lineStart, positiveInt(get(loc, "region", "endLine")) ?? lineStart);

      findings.push({
        source: opts.source,
        ruleId,
        filePath,
        lineStart,
        lineEnd,
        severity: severityOf(result, rule),
        message: str(get(result, "message", "text")) ?? str(get(rule, "shortDescription", "text")) ?? ruleId,
        reference: str(get(rule, "helpUri")),
      });
    }
  }
  return findings;
}
