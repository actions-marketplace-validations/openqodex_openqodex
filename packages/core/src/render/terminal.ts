import pc from "picocolors";
import type { Report, ReportFinding } from "../types.js";
import {
  SEVERITIES_DESC,
  candidateLocation,
  coverageLine,
  firstLine,
  location,
  sourceLabel,
  verdictLine,
} from "./common.js";

function findingLines(f: ReportFinding, c: ReturnType<typeof pc.createColors>): string[] {
  const lines = [`  ${c.bold(location(f))}  ${f.title}`];
  const desc = firstLine(f.description);
  if (desc) lines.push(`    ${desc}`);
  lines.push(`    ${c.dim(sourceLabel(f))}`);
  return lines;
}

export function renderTerminal(report: Report, opts: { color: boolean }): string {
  const c = pc.createColors(opts.color);
  const verdict = verdictLine(report);
  const out: string[] = [report.verdict === "blocked" ? c.red(c.bold(verdict)) : c.green(c.bold(verdict))];

  for (const severity of SEVERITIES_DESC) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const label = `${severity[0]?.toUpperCase()}${severity.slice(1)} (${group.length})`;
    out.push("", severity === "critical" || severity === "major" ? c.red(label) : c.yellow(label));
    for (const f of group) out.push(...findingLines(f, c));
  }

  if (report.outside_change.length > 0) {
    out.push("", "Outside the changed lines (not counted)");
    for (const f of report.outside_change) out.push(...findingLines(f, c));
  }
  if (report.not_reviewed.length > 0) {
    out.push("", "Not reviewed by the agent");
    for (const cand of report.not_reviewed) {
      out.push(`  ${cand.id} [${cand.token}] ${candidateLocation(cand)} (${cand.reviewSeverity}) ${firstLine(cand.message)}`);
    }
  }
  if (report.dropped.length > 0) {
    out.push("", "Dropped by the agent");
    for (const d of report.dropped) {
      out.push(`  ${d.candidate.id} [${d.candidate.token}] ${candidateLocation(d.candidate)}: ${firstLine(d.reason)}`);
    }
  }
  if (report.low_confidence.length > 0) {
    out.push("", "Below the confidence floor (not counted)");
    for (const l of report.low_confidence) {
      out.push(`  ${l.file_path}  ${l.title} (confidence ${l.confidence}, floor ${l.floor})`);
    }
  }
  if (report.not_reviewed_paths.length > 0) {
    out.push("", `Not reviewed, change too large: ${report.not_reviewed_paths.join(", ")}`);
  }
  out.push("", c.dim(coverageLine(report.scanners)));
  return `${out.join("\n")}\n`;
}
