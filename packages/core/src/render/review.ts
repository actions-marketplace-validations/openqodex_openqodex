// The standard report of a review run by `review` itself: one list of lines
// built from the report's fields, then dressed for the terminal (colour and
// indent) or for markdown (headings, bullets and bold labels). The words and
// their order are the same in both; only the markup differs.
import pc from "picocolors";
import type { Report, ReportFinding, ReviewerRecord } from "../types.js";
import { SEVERITIES_DESC, candidateLocation, coverageLine, display, location, severityBreakdown, verdictLine } from "./common.js";
import { impactLine } from "./terminal.js";

type Line =
  | { kind: "verdict"; text: string; bad: boolean }
  | { kind: "text"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "item"; text: string }
  | { kind: "field"; label: string; text: string };

const CLOSING = "Made by Qodex: review on every pull request at https://qodex.ai";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function reviewerLine(r: ReviewerRecord | null): string {
  if (r === null) return "Reviewer: none started";
  const parts = [`${r.driver} ${r.version}`, `${Math.round(r.duration_ms / 1000)} s`, plural(r.usage.turns, "turn", "turns")];
  if (r.rounds > 1) parts.push(plural(r.rounds - 1, "correction round", "correction rounds"));
  if (r.usage.input_tokens !== null) parts.push(`${r.usage.input_tokens.toLocaleString("en-US")} tokens in`);
  if (r.usage.output_tokens !== null) parts.push(`${r.usage.output_tokens.toLocaleString("en-US")} out`);
  if (r.usage.cost_usd !== null) parts.push(`$${r.usage.cost_usd.toFixed(2)}`);
  return `Reviewer: ${parts.join(", ")}`;
}

function findingLines(f: ReportFinding, n: number): Line[] {
  const label = `${f.severity[0]?.toUpperCase()}${f.severity.slice(1)} ${f.category}`;
  return [
    { kind: "item", text: `${n}. ${label}: ${f.title}` },
    { kind: "field", label: "Where", text: location(f) },
    { kind: "field", label: "Problem", text: f.problem ?? f.description },
    { kind: "field", label: "Why it matters", text: f.consequence ?? "" },
    { kind: "field", label: "Fix", text: f.fix ?? "" },
    { kind: "field", label: "Source", text: f.source ?? "the reviewer" },
  ];
}

function lines(report: Report): Line[] {
  const c = report.completion;
  const out: Line[] = [];
  const { files, additions, deletions } = report.stats;
  const changeLine = { kind: "text" as const, text: `Change ${report.change_id.slice(0, 12)} against ${report.base.ref}, ${plural(files, "file", "files")}, +${additions} -${deletions}` };
  const complete = c?.status === "complete";
  if (!complete) {
    out.push({ kind: "verdict", text: "Review incomplete: this is not a review of the change", bad: true }, changeLine, { kind: "heading", text: "Missing" });
    for (const m of c?.missing ?? ["no completion record"]) out.push({ kind: "item", text: m });
  } else {
    out.push({ kind: "verdict", text: verdictLine(report), bad: report.verdict === "blocked" }, changeLine);
    const risk = impactLine(report);
    if (risk) out.push({ kind: "text", text: risk });
    const counts = [report.findings.length > 0 ? `${plural(report.findings.length, "finding", "findings")} (${severityBreakdown(report.findings.map((f) => f.severity))})` : "no findings"];
    counts.push(`${plural(report.dropped.length, "scanner candidate", "scanner candidates")} dropped`);
    if (report.below_threshold > 0) counts.push(`${report.below_threshold} below the severity threshold`);
    out.push({ kind: "text", text: `Counts: ${counts.join(", ")}` });

    const ordered = SEVERITIES_DESC.flatMap((s) => report.findings.filter((f) => f.severity === s));
    out.push({ kind: "heading", text: `Findings (${ordered.length})` });
    if (ordered.length === 0) out.push({ kind: "text", text: "No findings on the changed lines." });
    ordered.forEach((f, i) => out.push(...findingLines(f, i + 1)));

    if (report.dropped.length > 0) {
      out.push({ kind: "heading", text: `Dropped scanner candidates (${report.dropped.length})` });
      for (const d of report.dropped) {
        const cited = d.cited ? ` (see ${d.cited.file_path}:${d.cited.line_number})` : "";
        out.push({ kind: "item", text: `${d.candidate.id} at ${candidateLocation(d.candidate)}: ${d.reason}${cited}` });
        out.push({ kind: "field", label: "Source", text: d.candidate.token });
      }
    }
    if (report.low_confidence.length > 0) {
      out.push({ kind: "heading", text: "Below the confidence floor (not counted)" });
      for (const l of report.low_confidence) out.push({ kind: "item", text: `${l.file_path}: ${l.title} (confidence ${l.confidence}, floor ${l.floor})` });
    }
  }
  if (c) {
    out.push({ kind: "heading", text: "Coverage" });
    out.push({ kind: "field", label: "Files read", text: c.coverage.files_read.length > 0 ? c.coverage.files_read.join(", ") : "none" });
    out.push({ kind: "field", label: "Files not read", text: c.coverage.files_not_read.length > 0 ? c.coverage.files_not_read.join(", ") : "none" });
    out.push({ kind: "field", label: "Changed ranges given to the reviewer", text: `${c.coverage.covered} of ${c.coverage.hunks}` });
  }
  if (report.not_reviewed_paths.length > 0) out.push({ kind: "field", label: "Left out, change too large", text: report.not_reviewed_paths.join(", ") });
  out.push({ kind: "text", text: `Scanners: ${coverageLine(report.scanners)}` });
  out.push({ kind: "text", text: reviewerLine(c?.reviewer ?? null) });
  out.push({ kind: "text", text: CLOSING });
  return out;
}

export function renderReview(report: Report, opts: { format: "terminal" | "markdown"; color?: boolean }): string {
  const c = pc.createColors(opts.format === "terminal" && opts.color === true);
  const out: string[] = [];
  for (const l of lines(report)) {
    if (l.kind === "field") {
      const text = display(l.text);
      out.push(opts.format === "markdown" ? `- **${l.label}:** ${text}` : `   ${c.dim(`${l.label}:`)} ${text}`);
      continue;
    }
    const text = display(l.text);
    if (opts.format === "markdown") {
      if (l.kind === "verdict") out.push(`# ${text}`, "");
      else if (l.kind === "heading") out.push("", `## ${text}`, "");
      else if (l.kind === "item") out.push("", `### ${text}`, "");
      else out.push(text, "");
      continue;
    }
    if (l.kind === "verdict") out.push(l.bad ? c.red(c.bold(text)) : c.green(c.bold(text)));
    else if (l.kind === "heading") out.push("", c.bold(text));
    else if (l.kind === "item") out.push(`${text}`);
    else out.push(text);
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
