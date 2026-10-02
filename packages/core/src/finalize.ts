// Turns what the agent wrote into a report, with no model. Every check
// either passes or throws OpenQodexError naming what is wrong; a finding is
// never repaired, so the agent fixes its file and runs finalize again.
//
// The config hash in the manifest (RunManifest.config_hash) is compared by
// the caller, which owns the hashing; this module checks everything else
// the manifest binds: the change id and the lenses the brief selected.
import { z } from "zod";
import { matchesGlob } from "./glob.js";
import { redactByFingerprint } from "./redact.js";
import { atOrAbove, severityRank } from "./severity.js";
import type {
  AgentFinding,
  AgentSubmission,
  Candidate,
  Category,
  Change,
  Config,
  Report,
  ReportFinding,
  RunManifest,
  ScannerSource,
  ScanResult,
  Severity,
  Verdict,
} from "./types.js";
import { OpenQodexError } from "./types.js";

const GLOBAL_CONFIDENCE_FLOOR = 0.7;

const severity = z.enum(["critical", "major", "minor", "nitpick", "info"]);
const category = z.enum(["bug", "security", "performance", "maintainability", "style"]);

const findingSchema = z.object({
  severity,
  category,
  confidence: z.number().min(0).max(1),
  file_path: z.string().min(1),
  line_number: z.number().int().min(1),
  line_end: z.number().int().min(1).optional(),
  title: z.string().min(1),
  description: z.string(),
  suggested_change: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  candidate: z.string().nullable().optional(),
});

const submissionSchema = z.object({
  version: z.literal(1),
  change_id: z.string().min(1),
  summary: z.string(),
  findings: z.array(findingSchema),
  dropped: z.array(z.object({ candidate: z.string().min(1), reason: z.string().min(1) })).optional(),
});

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : out ? `.${String(part)}` : String(part);
  }
  return out || "the top level";
}

function parseSubmission(submission: unknown): AgentSubmission {
  const parsed = submissionSchema.safeParse(submission);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? formatPath(issue.path) : "the top level";
    throw new OpenQodexError(`agent findings are invalid at ${where}: ${issue?.message ?? "invalid"}`);
  }
  const value = parsed.data;
  value.findings.forEach((f, i) => {
    if (f.line_end !== undefined && f.line_end < f.line_number) {
      throw new OpenQodexError(`agent findings are invalid at findings[${i}].line_end: it is before line_number`);
    }
  });
  return {
    ...value,
    findings: value.findings.map((f) => ({
      ...f,
      suggested_change: f.suggested_change ?? null,
      source: f.source ?? null,
    })),
  };
}

function sameChange(id: string, change: Change): boolean {
  return id === change.id || id === change.shortId;
}

const STALE = "the change moved since the brief; run openqodex review again";

// Citation checks, in order, for every finding and every dropped entry.
// `clean` redacts by fingerprint: every fragment of the agent's text that
// goes into an error message passes through it first.
function checkCitations(
  sub: AgentSubmission,
  scan: ScanResult,
  manifest: RunManifest,
  clean: (text: string) => string,
): void {
  const tokens = new Set(scan.candidates.map((c) => c.token));
  const byId = new Map(scan.candidates.map((c) => [c.id, c]));
  const lenses = new Set(manifest.lenses.map((l) => l.name));
  const raisedBy = new Map<string, number>();
  sub.findings.forEach((f, i) => {
    const at = `finding ${i} ("${clean(f.title)}")`;
    const src = f.source;
    if (src !== null) {
      const lensName = src.startsWith("lens:") ? src.slice("lens:".length) : null;
      const ok = tokens.has(src) || (lensName !== null && lenses.has(lensName));
      if (!ok) {
        throw new OpenQodexError(
          `${at} cites source "${clean(src)}", which is neither a scanner token in this scan nor a lens selected for this change; set source to one of those or to null`,
        );
      }
    }
    if (f.candidate !== undefined && f.candidate !== null) {
      const c = byId.get(f.candidate);
      if (!c) throw new OpenQodexError(`${at} raises candidate "${clean(f.candidate)}", which is not in this scan`);
      if (c.token !== src) {
        throw new OpenQodexError(`${at} raises candidate ${c.id}, whose token is "${c.token}", but its source is "${src === null ? "null" : clean(src)}"`);
      }
      raisedBy.set(c.id, i);
    }
  });
  (sub.dropped ?? []).forEach((d, j) => {
    if (!byId.has(d.candidate)) {
      throw new OpenQodexError(`dropped[${j}] names candidate "${clean(d.candidate)}", which is not in this scan`);
    }
    const raised = raisedBy.get(d.candidate);
    if (raised !== undefined) {
      throw new OpenQodexError(`candidate ${d.candidate} is both raised by finding ${raised} and listed in dropped[${j}]`);
    }
  });
}

function disabled(source: string | null, config: Config): boolean {
  return source !== null && config.disabledRules.some((glob) => matchesGlob(source, glob));
}

function touchesChange(f: AgentFinding, change: Change): string | null {
  if (!change.files.some((file) => file.path === f.file_path)) return "the file is not in this change";
  const lines = change.coverage.get(f.file_path);
  const end = f.line_end ?? f.line_number;
  if (lines) {
    for (const n of lines) if (f.line_number <= n && n <= end) return null;
  }
  const where = end > f.line_number ? `lines ${f.line_number} to ${end} are` : `line ${f.line_number} is`;
  return `${where} not a line this change added or modified`;
}

// Removes only true duplicates: same file, range and category, and the same
// candidate, or the same source when no candidate is cited, or the same title
// when neither is. Keeps the higher severity, then the first.
function dedup(findings: ReportFinding[]): ReportFinding[] {
  const kept = new Map<string, ReportFinding>();
  for (const f of findings) {
    const what = f.candidate ? `candidate\0${f.candidate}` : f.source ? `source\0${f.source}` : `title\0${f.title}`;
    const key = [f.file_path, f.line_number, f.line_end, f.category, what].join("\0");
    const prev = kept.get(key);
    if (!prev || severityRank(f.severity) > severityRank(prev.severity)) kept.set(key, f);
  }
  return [...kept.values()];
}

// One redaction pass over every string value in a finished report, run after
// the coverage decisions so they still match on the raw paths.
function redactAll<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactAll(v, clean)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactAll(v, clean)])) as T;
  }
  return value;
}

function verdictFor(threshold: Severity | null, severities: Severity[]): Verdict {
  return threshold && severities.some((s) => atOrAbove(s, threshold)) ? "blocked" : "passed";
}

export function finalizeReview(args: {
  change: Change;
  scan: ScanResult;
  manifest: RunManifest;
  config: Config;
  submission: unknown;
}): Report {
  const { change, scan, manifest, config } = args;
  const sub = parseSubmission(args.submission);
  if (!sameChange(sub.change_id, change) || !sameChange(manifest.change_id, change)) {
    throw new OpenQodexError(STALE);
  }
  const clean = (text: string) => redactByFingerprint(text, scan.secretFingerprints);
  checkCitations(sub, scan, manifest, clean);
  const floors = new Map(manifest.lenses.map((l) => [l.name, l.confidenceFloor]));

  const findings: ReportFinding[] = [];
  const outside: ReportFinding[] = [];
  const lowConfidence: Report["low_confidence"] = [];
  const raised = new Set<string>();

  for (const f of sub.findings) {
    if (f.candidate) raised.add(f.candidate);
    if (disabled(f.source, config)) continue;
    const lensFloor = f.source?.startsWith("lens:") ? floors.get(f.source.slice("lens:".length)) : undefined;
    const floor = Math.max(GLOBAL_CONFIDENCE_FLOOR, lensFloor ?? 0);
    if (f.confidence < floor) {
      lowConfidence.push({ title: f.title, file_path: f.file_path, confidence: f.confidence, floor });
      continue;
    }
    const outsideReason = touchesChange(f, change);
    const entry: ReportFinding = {
      origin: "agent",
      severity: f.severity,
      category: f.category,
      confidence: f.confidence,
      file_path: f.file_path,
      line_number: f.line_number,
      line_end: f.line_end ?? f.line_number,
      title: f.title,
      description: f.description,
      suggested_change: f.suggested_change,
      source: f.source,
      candidate: f.candidate ?? null,
      notes: outsideReason ? [outsideReason] : [],
    };
    (outsideReason ? outside : findings).push(entry);
  }

  const droppedIds = new Map((sub.dropped ?? []).map((d) => [d.candidate, d.reason]));
  const live = scan.candidates.filter((c) => !disabled(c.token, config));
  const notReviewed = live.filter((c) => !raised.has(c.id) && !droppedIds.has(c.id));
  const dropped = live
    .filter((c) => droppedIds.has(c.id))
    .map((c) => ({ candidate: c, reason: droppedIds.get(c.id) ?? "" }));

  const kept = dedup(findings);
  const verdict = verdictFor(config.blockOnSeverity, [
    ...kept.map((f) => f.severity),
    ...notReviewed.map((c) => c.reviewSeverity),
  ]);

  const report: Report = {
    version: 1,
    kind: "review",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date().toISOString(),
    verdict,
    block_on_severity: config.blockOnSeverity,
    summary: sub.summary,
    findings: kept,
    outside_change: outside,
    low_confidence: lowConfidence,
    not_reviewed: notReviewed,
    dropped,
    scanners: scan.scanners,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
  return redactAll(report, clean);
}

// What each scanner's findings are about, for a scan-only report.
const SECURITY_SCANNERS = new Set<ScannerSource>(["gitleaks", "semgrep", "bandit", "brakeman", "osv-scanner"]);

export function scannerCategory(source: ScannerSource): Category {
  return SECURITY_SCANNERS.has(source) || source.startsWith("custom:") ? "security" : "maintainability";
}

function candidateFinding(c: Candidate): ReportFinding {
  return {
    origin: "scanner",
    severity: c.reviewSeverity,
    category: scannerCategory(c.source),
    confidence: null,
    file_path: c.filePath,
    line_number: c.lineStart,
    line_end: Math.max(c.lineStart, c.lineEnd),
    title: c.ruleId,
    description: c.message,
    suggested_change: null,
    source: c.token,
    candidate: c.id,
    notes: [],
  };
}

export function scanReport(args: { change: Change; scan: ScanResult; config: Config }): Report {
  const { change, scan, config } = args;
  const clean = (text: string) => redactByFingerprint(text, scan.secretFingerprints);
  const findings = scan.candidates
    .filter((c) => !disabled(c.token, config))
    .map((c) => candidateFinding(c));
  const report: Report = {
    version: 1,
    kind: "scan",
    change_id: change.id,
    base: { ref: change.baseRef, sha: change.baseSha },
    generated_at: new Date().toISOString(),
    verdict: verdictFor(
      config.blockOnSeverity,
      findings.map((f) => f.severity),
    ),
    block_on_severity: config.blockOnSeverity,
    summary: null,
    findings,
    outside_change: [],
    low_confidence: [],
    not_reviewed: [],
    dropped: [],
    scanners: scan.scanners,
    not_reviewed_paths: change.notReviewed,
    stats: change.stats,
  };
  return redactAll(report, clean);
}
