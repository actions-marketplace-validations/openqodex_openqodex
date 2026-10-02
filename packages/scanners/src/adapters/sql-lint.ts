// In-process SQL / Postgres static analyzer. Unlike the other adapters
// (external binaries), this runs inside OpenQodex: it reads the changed
// `.sql` files from the working tree and applies deterministic checks for
// common Postgres / Supabase footguns in migrations.
//
// It emits the same StaticFinding shape as the other adapters, so the
// rest of the pipeline (changed-line filter, review brief, citation
// token, disabled-rules) treats it identically. Findings are CANDIDATES
// the reviewing agent verifies before raising, cited as `sqllint:<ruleId>`.
// The matching lenses give the agent the reasoning to confirm or drop each
// one.
//
// Deliberately conservative: each check fires only on a strong, in-file
// signal so the candidates stay high-precision. Checks that need
// cross-file / cross-migration reasoning (migration ordering, downstream
// contract breaks) are out of scope here: they belong to the lenses.

import type { AdapterResult, StaticFinding } from "@openqodex/core";
import type { Adapter } from "./index.js";
import { readRepoFile } from "./read.js";

// A migration bigger than this is not read.
const SQL_MAX_BYTES = 5 * 1024 * 1024;

export type SqlLintRunArgs = {
  repoDir: string;
  changedPaths: string[];
};

function isSqlPath(p: string): boolean {
  return p.toLowerCase().endsWith(".sql");
}

// Strip schema + quotes from a (possibly qualified) function name.
// public."Foo" -> foo ; admin_get_x -> admin_get_x
function baseName(qualified: string): string {
  const last = qualified.split(".").pop() ?? qualified;
  return last.replace(/"/g, "").trim().toLowerCase();
}

// A function whose name signals admin / internal / privileged scope:
// the high-risk case for a default PUBLIC EXECUTE grant. Keeps the
// no-revoke check high-precision instead of firing on every function.
function looksPrivileged(name: string): boolean {
  return /^(admin[_-]|internal[_-])/.test(name) || /admin/.test(name);
}

// Split a SQL file into per-function chunks delimited by CREATE [OR
// REPLACE] FUNCTION boundaries. Each chunk is { startLine (1-based),
// lines } and holds one function's header/body plus any trailing
// statements until the next CREATE FUNCTION. SECURITY DEFINER and SET
// search_path both live in the header, so chunk-scoped checks are sound.
type FnChunk = { startLine: number; nameLine: number; name: string; lines: string[] };

const CREATE_FN_RE = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(/i;

function splitFunctionChunks(lines: string[]): FnChunk[] {
  const chunks: FnChunk[] = [];
  let current: FnChunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CREATE_FN_RE);
    if (m) {
      if (current) chunks.push(current);
      current = { startLine: i + 1, nameLine: i + 1, name: baseName(m[1]), lines: [lines[i]] };
    } else if (current) {
      current.lines.push(lines[i]);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Pure, testable core: lint one SQL file's source. filePath is whatever
// path you want stamped on findings (relative to the repo root in use).
export function lintSqlSource(filePath: string, content: string): StaticFinding[] {
  const findings: StaticFinding[] = [];
  const lines = content.split("\n");
  const chunks = splitFunctionChunks(lines);

  // REVOKE ... FROM PUBLIC statements in the file, split per statement so
  // a revoke for function A doesn't suppress the check for function B.
  // A blanket "REVOKE ... ON ALL FUNCTIONS IN SCHEMA ... FROM PUBLIC"
  // covers every function; otherwise a function is only considered
  // covered when a revoke statement names it.
  const revokeStatements = content
    .split(";")
    .filter((s) => /\brevoke\b/i.test(s) && /from\s+public/i.test(s));
  const hasBlanketRevoke = revokeStatements.some((s) =>
    /on\s+all\s+functions\s+in\s+schema/i.test(s),
  );
  // How many times each base name is CREATEd in the file: to detect
  // overloads, where EXECUTE is per-signature and a name-only revoke
  // match is unsafe.
  const createCounts = new Map<string, number>();
  for (const c of chunks) {
    createCounts.set(c.name, (createCounts.get(c.name) ?? 0) + 1);
  }
  // Does a REVOKE ... FROM PUBLIC cover this specific function? Postgres
  // EXECUTE is per signature, and the argument list can only be OMITTED
  // when the name is unique (a bare-name revoke on an overloaded name
  // errors "function name is not unique"). So for an OVERLOADED name
  // neither a bare nor a parenthesized revoke is a safe match: we can't
  // map foo(text) to foo(integer): and we do NOT suppress; flag every
  // overload and let the reviewer verify (conservative; that's the
  // analyzer's job). Only a blanket all-functions revoke (handled
  // above) covers overloads. For a NON-overloaded name, either a bare
  // or a parenthesized revoke naming it is an unambiguous match.
  const hasOwnRevoke = (base: string): boolean => {
    const overloaded = (createCounts.get(base) ?? 0) >= 2;
    if (overloaded) return false;
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bareRe = new RegExp(`\\bfunction\\s+(?:"?[a-z0-9_]+"?\\.)?"?${esc}"?\\s+from\\b`, "i");
    const parenRe = new RegExp(`\\b"?${esc}"?\\s*\\(`, "i");
    return revokeStatements.some((s) => bareRe.test(s) || parenRe.test(s));
  };

  // Schema-qualified function base names defined in this file, for the
  // unqualified-COMMENT check.
  const qualifiedCreatedBases = new Set<string>();
  for (const line of lines) {
    const m = line.match(/create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(/i);
    if (m && m[1].includes(".")) qualifiedCreatedBases.add(baseName(m[1]));
  }

  // Check 1: a privileged function created with no REVOKE ... FROM PUBLIC
  // covering IT. Postgres grants EXECUTE to PUBLIC by default, and
  // PostgREST exposes it as an RPC: so an admin function stays
  // world-callable. Matched per-function (or a blanket all-functions
  // revoke) so a revoke for one function doesn't mask another that's
  // missing its own. Anchored on the CREATE line.
  for (const chunk of chunks) {
    if (!looksPrivileged(chunk.name)) continue;
    if (hasBlanketRevoke || hasOwnRevoke(chunk.name)) continue;
    findings.push({
      source: "sqllint",
      ruleId: "function-default-public-execute",
      filePath,
      lineStart: chunk.nameLine,
      lineEnd: chunk.nameLine,
      severity: "high",
      message:
        `Function "${chunk.name}" looks privileged (admin/internal) but the file has no ` +
        `REVOKE EXECUTE ... FROM PUBLIC. Postgres grants EXECUTE to PUBLIC by default and ` +
        `PostgREST exposes it as an RPC, so it may be callable by anon/authenticated. ` +
        `Add REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC plus an explicit GRANT to the intended role.`,
      reference: null,
    });
  }

  // Check 2: SECURITY DEFINER function without a pinned SET search_path
  // (search_path hijack / privilege escalation; Supabase's
  // function_search_path_mutable). Chunk-scoped.
  for (const chunk of chunks) {
    const chunkText = chunk.lines.join("\n");
    if (!/security\s+definer/i.test(chunkText)) continue;
    if (/set\s+search_path/i.test(chunkText)) continue;
    const offset = chunk.lines.findIndex((l) => /security\s+definer/i.test(l));
    const line = chunk.startLine + (offset < 0 ? 0 : offset);
    findings.push({
      source: "sqllint",
      ruleId: "security-definer-no-search-path",
      filePath,
      lineStart: line,
      lineEnd: line,
      severity: "high",
      message:
        `SECURITY DEFINER function "${chunk.name}" has no pinned SET search_path. A caller can ` +
        `shadow unqualified references via their own search_path and run them with the owner's ` +
        `privileges. Add SET search_path = pg_catalog, public (or fully-qualify all references).`,
      reference: null,
    });
  }

  // Check 3: COMMENT ON FUNCTION with an unqualified name while the
  // function is created schema-qualified: the COMMENT resolves against
  // the applying session's search_path and can fail / drift.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/comment\s+on\s+function\s+([^\s(]+)\s*\(/i);
    if (!m) continue;
    if (m[1].includes(".")) continue; // already qualified
    const base = baseName(m[1]);
    if (!qualifiedCreatedBases.has(base)) continue;
    findings.push({
      source: "sqllint",
      ruleId: "comment-on-function-unqualified",
      filePath,
      lineStart: i + 1,
      lineEnd: i + 1,
      severity: "low",
      message:
        `COMMENT ON FUNCTION "${base}" is unqualified but the function is created schema-qualified. ` +
        `The COMMENT resolves against the applying session's search_path and can fail with ` +
        `"function does not exist". Qualify it to match the CREATE (e.g. public.${base}).`,
      reference: null,
    });
  }

  return findings;
}

// Adapter entry point: read changed .sql files from the working tree and
// lint each. Never throws: a read error is captured into the result and
// that file is skipped (static analysis is additive, never a gate).
export async function runSqlLint(args: SqlLintRunArgs): Promise<AdapterResult> {
  const sqlPaths = args.changedPaths.filter(isSqlPath);
  if (sqlPaths.length === 0) return { findings: [], error: null };

  const findings: StaticFinding[] = [];
  const errors: string[] = [];
  for (const rel of sqlPaths) {
    try {
      const content = await readRepoFile(args.repoDir, rel, SQL_MAX_BYTES);
      findings.push(...lintSqlSource(rel, content));
    } catch (err) {
      errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    findings,
    error: errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
  };
}

// In-process: the runner never resolves a tool for it.
export const sqllint: Adapter = {
  source: "sqllint",
  wants: (changedPaths) => changedPaths.some(isSqlPath),
  run: (args) => runSqlLint(args),
};
