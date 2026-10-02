// Wording shared by the renderers and the brief, so the terminal, the
// markdown report and the brief say the same thing the same way.
import { SEVERITIES, atOrAbove } from "../severity.js";
import type { Candidate, Report, ReportFinding, ScannerRunSummary, Severity } from "../types.js";

// Highest first, the order findings are shown in.
export const SEVERITIES_DESC: readonly Severity[] = [...SEVERITIES].reverse();

// Text from a scanner or the agent made safe for a terminal: every run of
// whitespace (line breaks included) becomes one space, and every remaining
// C0 or C1 control character is dropped, so nothing can move the cursor,
// clear the screen or start a new line.
export function display(text: string): string {
// Matching control characters is the point here.
// oxlint-disable-next-line no-control-regex
  return text.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// "7 scanners ran, 4 had nothing to check, 2 not included (brakeman: needs
// Ruby 2.7 or newer; semgrep: first run only, still installing)"
export function coverageLine(scanners: ScannerRunSummary[]): string {
  const ran = scanners.filter((s) => s.status === "ran").length;
  const idle = scanners.filter((s) => s.status === "no_matching_files").length;
  const out = scanners.filter((s) => s.status !== "ran" && s.status !== "no_matching_files");
  const parts = [`${plural(ran, "scanner", "scanners")} ran`];
  if (idle > 0) parts.push(`${idle} had nothing to check`);
  if (out.length > 0) {
    const reasons = out.map((s) => display(`${s.scanner}: ${s.reason ?? s.status.replace(/_/g, " ")}`)).join("; ");
    parts.push(`${out.length} not included (${reasons})`);
  }
  return parts.join(", ");
}

// The severities of everything that counts toward the verdict: findings on
// changed lines and candidates the agent left unreviewed.
export function countedSeverities(report: Report): Severity[] {
  return [...report.findings.map((f) => f.severity), ...report.not_reviewed.map((c) => c.reviewSeverity)];
}

// "1 critical, 2 minor"
export function severityBreakdown(severities: Severity[]): string {
  return SEVERITIES_DESC.map((s) => [s, severities.filter((x) => x === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

export function verdictLine(report: Report): string {
  const counted = countedSeverities(report);
  const threshold = report.block_on_severity;
  const what = (n: number) => plural(n, "finding", "findings");
  if (report.verdict === "blocked" && threshold) {
    const over = counted.filter((s) => atOrAbove(s, threshold));
    return `Blocked: ${what(over.length)} at or above ${threshold} (${severityBreakdown(counted)})`;
  }
  if (counted.length === 0) return "Passed: no findings";
  if (!threshold) return `Passed with warnings: ${what(counted.length)} (${severityBreakdown(counted)})`;
  return `Passed: nothing at or above ${threshold}, ${what(counted.length)} below it (${severityBreakdown(counted)})`;
}

export function location(f: { file_path: string; line_number: number; line_end: number }): string {
  return f.line_end > f.line_number ? `${f.file_path}:${f.line_number}-${f.line_end}` : `${f.file_path}:${f.line_number}`;
}

export function candidateLocation(c: Candidate): string {
  return c.lineEnd > c.lineStart ? `${c.filePath}:${c.lineStart}-${c.lineEnd}` : `${c.filePath}:${c.lineStart}`;
}

export function sourceLabel(f: ReportFinding): string {
  return f.source ?? (f.origin === "agent" ? "agent" : "scanner");
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}
