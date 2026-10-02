import type { Report, ReportFinding } from "../types.js";
import { SEVERITIES_DESC, candidateLocation, coverageLine, location, sourceLabel, verdictLine } from "./common.js";

const CLOSING = "Made by Qodex: review on every pull request at https://qodex.ai";

// One table cell: no pipes, no line breaks.
function cell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n+/g, "<br>").trim();
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function findingTable(findings: ReportFinding[]): string[] {
  const ordered = SEVERITIES_DESC.flatMap((s) => findings.filter((f) => f.severity === s));
  const rows = ["| Severity | Location | Finding | Source |", "|---|---|---|---|"];
  for (const f of ordered) {
    const text = f.description ? `**${cell(f.title)}**<br>${cell(f.description)}` : `**${cell(f.title)}**`;
    const notes = f.notes.length > 0 ? `<br>_${cell(f.notes.join("; "))}_` : "";
    rows.push(`| ${f.severity} | ${code(location(f))} | ${text}${notes} | ${code(sourceLabel(f))} |`);
  }
  return rows;
}

export function renderMarkdown(report: Report): string {
  const title = report.kind === "review" ? "OpenQodex review" : "OpenQodex scan";
  const { files, additions, deletions } = report.stats;
  const out = [
    `# ${title}`,
    "",
    `**${verdictLine(report)}**`,
    "",
    `Change ${code(report.change_id.slice(0, 12))} against ${code(report.base.ref)} (${code(report.base.sha.slice(0, 12))}), ${files} ${files === 1 ? "file" : "files"}, +${additions} -${deletions}.`,
  ];
  if (report.summary) out.push("", "## Summary", "", report.summary.trim());

  out.push("", "## Findings", "");
  if (report.findings.length === 0) out.push("No findings on the changed lines.");
  else out.push(...findingTable(report.findings));

  if (report.outside_change.length > 0) {
    out.push("", "## Outside the changed lines", "", "Shown for information; these never count toward the verdict.", "");
    out.push(...findingTable(report.outside_change));
  }
  if (report.not_reviewed.length > 0) {
    out.push(
      "",
      "## Not reviewed by the agent",
      "",
      "Scanner candidates the agent neither raised nor dropped. They count toward the verdict.",
      "",
      "| Id | Severity | Location | Rule | Message |",
      "|---|---|---|---|---|",
    );
    for (const c of report.not_reviewed) {
      out.push(`| ${c.id} | ${c.reviewSeverity} | ${code(candidateLocation(c))} | ${code(c.token)} | ${cell(c.message)} |`);
    }
  }
  if (report.dropped.length > 0) {
    out.push("", "## Dropped by the agent", "", "| Id | Location | Rule | Reason |", "|---|---|---|---|");
    for (const d of report.dropped) {
      out.push(`| ${d.candidate.id} | ${code(candidateLocation(d.candidate))} | ${code(d.candidate.token)} | ${cell(d.reason)} |`);
    }
  }
  if (report.low_confidence.length > 0) {
    out.push("", "## Below the confidence floor", "", "| File | Finding | Confidence | Floor |", "|---|---|---|---|");
    for (const l of report.low_confidence) {
      out.push(`| ${code(l.file_path)} | ${cell(l.title)} | ${l.confidence} | ${l.floor} |`);
    }
  }
  if (report.not_reviewed_paths.length > 0) {
    out.push("", "## Not reviewed, change too large", "");
    for (const p of report.not_reviewed_paths) out.push(`- ${code(p)}`);
  }

  out.push("", "## Scanners", "", coverageLine(report.scanners));
  if (report.scanners.length > 0) {
    out.push(
      "",
      "<details><summary>Scanner details</summary>",
      "",
      "| Scanner | Status | Version | Found | Kept | Time | Reason |",
      "|---|---|---|---|---|---|---|",
    );
    for (const s of report.scanners) {
      out.push(
        `| ${s.scanner} | ${s.status.replace(/_/g, " ")} | ${s.version ?? ""} | ${s.rawCount} | ${s.keptCount} | ${(s.durationMs / 1000).toFixed(1)} s | ${cell(s.reason ?? "")} |`,
      );
    }
    out.push("", "</details>");
  }
  if (report.kind === "review") out.push("", "---", "", CLOSING);
  return `${out.join("\n")}\n`;
}
