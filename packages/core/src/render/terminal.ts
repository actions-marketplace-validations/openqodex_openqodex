import pc from "picocolors";
import type { Report, ReportFinding } from "../types.js";
import {
  SEVERITIES_DESC,
  candidateLocation,
  coverageLine,
  display,
  firstLine,
  location,
  sourceLabel,
  verdictLine,
} from "./common.js";

// Every value that came from a scanner or the agent goes through `display`
// before the renderer adds its own colour codes.
function findingLines(f: ReportFinding, c: ReturnType<typeof pc.createColors>): string[] {
  const lines = [`  ${c.bold(display(location(f)))}  ${display(f.title)}`];
  const desc = display(firstLine(f.description));
  if (desc) lines.push(`    ${desc}`);
  lines.push(`    ${c.dim(display(sourceLabel(f)))}`);
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
      const where = display(`${cand.id} [${cand.token}] ${candidateLocation(cand)}`);
      out.push(`  ${where} (${cand.reviewSeverity}) ${display(firstLine(cand.message))}`);
    }
  }
  if (report.dropped.length > 0) {
    out.push("", "Dropped by the agent");
    for (const d of report.dropped) {
      out.push(`  ${display(`${d.candidate.id} [${d.candidate.token}] ${candidateLocation(d.candidate)}: ${firstLine(d.reason)}`)}`);
    }
  }
  if (report.low_confidence.length > 0) {
    out.push("", "Below the confidence floor (not counted)");
    for (const l of report.low_confidence) {
      out.push(`  ${display(l.file_path)}  ${display(l.title)} (confidence ${l.confidence}, floor ${l.floor})`);
    }
  }
  if (report.not_reviewed_paths.length > 0) {
    out.push("", `Not reviewed, change too large: ${display(report.not_reviewed_paths.join(", "))}`);
  }
  out.push("", c.dim(coverageLine(report.scanners)));
  return `${out.join("\n")}\n`;
}
