// report.html: one self-contained page beside report.md. Each changed file
// is shown as a unified diff with each finding under the line it cites; the
// verdict and the summary are on top; coverage, the scanners and the blast
// radius below. A pure function of the report and its display model.
//
// The page quotes code under review and text from the reviewer and the
// scanners, so it is built to hold hostile text: every string is escaped,
// every anchor id is generated (never a path), there is no script, no
// inline style attribute and no external reference, and the page's policy
// allows nothing but its own stylesheet, by hash. Secrets are redacted in
// the display model before this runs (display.ts).
//
// The markup is built from the data here; the look is in html-style.ts.
import { createHash } from "node:crypto";
import type { Candidate, ImpactEdge, ImpactSummary, Report, ReportFinding, ScannerRunSummary } from "../types.js";
import { CLOSING, product, reviewerLine } from "./review.js";
import { candidateLocation, coverageLine, display, location, notOpenedLabel, orderFindings, severityBreakdown, verdictLine } from "./common.js";
import type { Display, DisplayFile, DisplayRow } from "./display.js";
import { REPORT_CSS } from "./html-style.js";
import { impactLine } from "./terminal.js";

export type HtmlInput = {
  report: Report;
  // null: the code was not captured (a run from before report.html, or a
  // saved display that did not match); the findings are shown by file.
  display: Display | null;
  version: string;
  // The run folder's name.
  runId?: string | null;
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Text for the page: control characters other than tab and line break
// dropped, then every character HTML gives meaning to escaped.
function esc(text: string): string {
  // Matching control characters is the point here.
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

// One line of prose: whitespace runs become one space, then escaped.
const line = (text: string): string => esc(display(text));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

// The page's policy: nothing loads, nothing runs, nothing is sent; the one
// stylesheet is allowed by its hash, so a style element anywhere else in the
// page (from text that escaped its escaping) would not apply.
function policy(css: string): string {
  const hash = createHash("sha256").update(css, "utf8").digest("base64");
  return [
    "default-src 'none'",
    `style-src 'sha256-${hash}'`,
    "script-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

type Card = { kind: "finding"; n: number; f: ReportFinding } | { kind: "dropped"; d: Report["dropped"][number] };

// Where each card goes: under a row of its file (by new-side line), or in
// its file's group of findings on lines the page does not show.
type Placed = { file: DisplayFile; index: number; atLine: Map<number, Card[]>; elsewhere: Card[] };

function place(report: Report, files: DisplayFile[]): Placed[] {
  const placed: Placed[] = files.map((file, index) => ({ file, index: index + 1, atLine: new Map(), elsewhere: [] }));
  const byPath = new Map(placed.map((p) => [p.file.path, p]));
  const shown = new Map(placed.map((p) => [p.file.path, new Set(p.file.hunks.flatMap((h) => h.rows).filter((r) => r.new !== null && r.kind !== "del").map((r) => r.new as number))]));
  const put = (path: string, at: number, card: Card): void => {
    let p = byPath.get(path);
    if (p === undefined) {
      const file: DisplayFile = { path, old_path: null, status: "modified", binary: false, additions: null, deletions: null, hunks: [], note: "The code of this file is not on this page." };
      p = { file, index: placed.length + 1, atLine: new Map(), elsewhere: [] };
      placed.push(p);
      byPath.set(path, p);
      shown.set(path, new Set());
    }
    if (shown.get(path)?.has(at)) p.atLine.set(at, [...(p.atLine.get(at) ?? []), card]);
    else p.elsewhere.push(card);
  };
  orderFindings(report.findings).forEach((f, i) => put(f.file_path, f.line_number, { kind: "finding", n: i + 1, f }));
  for (const d of report.dropped) put(d.cited?.file_path ?? d.candidate.filePath, d.cited?.line_number ?? d.candidate.lineStart, { kind: "dropped", d });
  return placed;
}

function findingCard(n: number, f: ReportFinding): string {
  const fields: [string, string][] = f.problem !== undefined
    ? [["Problem", f.problem], ["Why it matters", f.consequence ?? ""], ["Fix", f.fix ?? ""]]
    : [["Description", f.description]];
  fields.push(["Source", f.source ?? (f.origin === "agent" ? "the reviewer" : "a scanner")]);
  if (f.confidence !== null) fields.push(["Confidence", String(f.confidence)]);
  for (const note of f.notes) fields.push(["Note", note]);
  const suggested = f.suggested_change !== null && f.suggested_change.trim() !== ""
    ? `<details class="suggested"><summary>Suggested change</summary><pre><code>${esc(f.suggested_change)}</code></pre></details>`
    : "";
  return [
    `<article class="finding-card severity-${esc(f.severity)}" id="finding-${n}">`,
    `<header class="finding-head"><a class="finding-id" href="#index-${n}">${n}</a><span class="severity">${esc(f.severity)}</span><span class="category">${line(f.category)}</span><h4 class="finding-title">${line(f.title)}</h4><span class="where">${line(location(f))}</span></header>`,
    `<dl class="finding-body">${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${line(v)}</dd>`).join("")}</dl>`,
    suggested,
    "</article>",
  ].join("");
}

function droppedCard(d: Report["dropped"][number]): string {
  const c = d.candidate;
  const fields: [string, string][] = [["Scanner said", c.message], ["Reason", d.reason], ["At", candidateLocation(c)]];
  if (d.cited) fields.push(["The line that shows why", `${d.cited.file_path}:${d.cited.line_number}`]);
  return `<details class="dropped"><summary>Dropped scanner candidate ${line(c.id)}: ${line(c.token)}</summary><dl>${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${line(v)}</dd>`).join("")}</dl></details>`;
}

const card = (c: Card): string => (c.kind === "finding" ? findingCard(c.n, c.f) : droppedCard(c.d));

function rowHtml(r: DisplayRow): string {
  const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
  const label = r.kind === "add" ? "added" : r.kind === "del" ? "removed" : "unchanged";
  const attrs = `${r.old !== null ? ` data-old="${r.old}"` : ""}${r.new !== null ? ` data-new="${r.new}"` : ""}`;
  const notes = [r.cut ? "line cut for this page" : "", r.noNewline ? "no newline at end of file" : ""].filter((x) => x !== "");
  const tail = notes.length > 0 ? ` <span class="line-note">(${esc(notes.join("; "))})</span>` : "";
  return `<tr class="line line-${r.kind}"${attrs}><td class="num old">${r.old ?? ""}</td><td class="num new">${r.new ?? ""}</td><td class="sign" aria-label="${label}">${sign}</td><td class="text"><code>${esc(r.text)}</code>${tail}</td></tr>`;
}

const STATUS: Record<DisplayFile["status"], string> = { added: "added", modified: "modified", deleted: "deleted", renamed: "renamed" };

function fileSection(p: Placed): string {
  const f = p.file;
  const stats = f.additions !== null ? `<span class="file-stats">+${f.additions} -${f.deletions ?? 0}</span>` : "";
  const head = `<header class="file-head"><h3 class="path">${line(f.path)}</h3>${f.old_path !== null ? `<span class="file-status">renamed from ${line(f.old_path)}</span>` : `<span class="file-status">${STATUS[f.status]}</span>`}${stats}</header>`;
  const note = f.note !== null ? `<p class="file-note">${line(f.note)}</p>` : "";
  const heading = f.status === "deleted" ? "Findings on the deleted file" : "Findings on lines this page does not show";
  const elsewhere = p.elsewhere.length > 0 ? `<div class="file-findings"><h4>${heading}</h4>${p.elsewhere.map(card).join("")}</div>` : "";
  const hunks = f.hunks
    .map((h) => {
      const top = h.old_lines === 0 && h.new_lines === 0 ? "" : `<tr class="hunk-head"><td colspan="4">${esc(`@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`)}${h.section !== "" ? ` ${line(h.section)}` : ""}</td></tr>`;
      const body = h.rows
        .map((r) => {
          const cards = r.new !== null && r.kind !== "del" ? (p.atLine.get(r.new) ?? []) : [];
          return rowHtml(r) + (cards.length > 0 ? `<tr class="comments"><td colspan="4">${cards.map(card).join("")}</td></tr>` : "");
        })
        .join("");
      return `<tbody class="hunk">${top}${body}</tbody>`;
    })
    .join("");
  const table = hunks !== "" ? `<div class="diff-scroll"><table class="diff"><caption hidden>Changes to ${line(f.path)}</caption><thead hidden><tr><th>Old line</th><th>New line</th><th>Change</th><th>Code</th></tr></thead>${hunks}</table></div>` : "";
  return `<section class="file" id="file-${p.index}" aria-label="${line(f.path)}">${head}${note}${elsewhere}${table}</section>`;
}

function header(report: Report, input: HtmlInput): string {
  const c = report.completion;
  const complete = c === undefined || c.status === "complete";
  const verdict = complete ? verdictLine(report) : "Review incomplete: this is not a review of the change";
  const cls = !complete ? "verdict-incomplete" : report.verdict === "blocked" ? "verdict-blocked" : "verdict-passed";
  const facts: [string, string][] = [
    ["Change", `${report.change_id.slice(0, 12)} against ${report.base.ref} (${report.base.sha.slice(0, 12)}), ${plural(report.stats.files, "file", "files")}, +${report.stats.additions} -${report.stats.deletions}`],
    ["Blocks at", report.block_on_severity ?? "never (warnings only)"],
    ["Reviewer", c?.reviewer ? `${c.reviewer.driver} ${c.reviewer.version}` : report.reviewed_by ?? "none started"],
    ["Written", report.generated_at],
  ];
  if (input.runId) facts.push(["Run", input.runId]);
  const missing = !complete ? `<section class="missing" aria-label="What is missing"><h2>Missing</h2><ul>${(c?.missing ?? ["no completion record"]).map((m) => `<li>${line(m)}</li>`).join("")}</ul></section>` : "";
  return [
    '<header class="header" id="top">',
    '<p class="product">OpenQodex review</p>',
    `<h1 class="verdict ${cls}">${line(verdict)}</h1>`,
    report.reviewed_by && c === undefined ? `<p class="reviewed-by">${line(report.reviewed_by)}</p>` : "",
    `<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${line(v)}</dd></div>`).join("")}</dl>`,
    missing,
    "</header>",
  ].join("");
}

function coverage(report: Report): string {
  const c = report.completion;
  const rows: [string, string][] = [];
  if (c) {
    rows.push(["Changed ranges given to the reviewer", `${c.coverage.covered} of ${c.coverage.hunks}`]);
    rows.push(["Scanner candidates checked", `${c.candidates.disposed} of ${c.candidates.total}`]);
    if (c.trace_complete === false) {
      const by = `not recorded by ${c.reviewer ? product(c.reviewer.driver) : "the reviewer"}`;
      rows.push(["Files the reviewer opened", by]);
    } else {
      rows.push(["Files the reviewer opened", c.coverage.files_read.length > 0 ? c.coverage.files_read.join(", ") : "none"]);
      rows.push([notOpenedLabel(c.coverage), c.coverage.files_not_read.length > 0 ? c.coverage.files_not_read.join(", ") : "none"]);
      rows.push(["Reads outside the snapshot", c.outside_reads.length > 0 ? c.outside_reads.join(", ") : "none"]);
    }
  } else {
    rows.push(["Coverage", "not measured: the coding agent you are using reviewed this change itself"]);
  }
  if (report.not_reviewed_paths.length > 0) rows.push(["Left out, change too large", report.not_reviewed_paths.join(", ")]);
  rows.push(["Scanners", coverageLine(report.scanners)]);
  return `<section class="coverage" id="coverage"><h2>Coverage</h2><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${line(v)}</dd>`).join("")}</dl></section>`;
}

function filesIndex(placed: Placed[], report: Report): string {
  const counts = new Map<string, number>();
  for (const f of report.findings) counts.set(f.file_path, (counts.get(f.file_path) ?? 0) + 1);
  const rows = placed.map((p) => {
    const n = counts.get(p.file.path) ?? 0;
    const delta = p.file.additions !== null ? `+${p.file.additions} -${p.file.deletions ?? 0}` : "";
    return `<tr><td><a href="#file-${p.index}">${line(p.file.path)}</a></td><td>${STATUS[p.file.status]}</td><td class="num">${esc(delta)}</td><td class="num">${plural(n, "finding", "findings")}</td></tr>`;
  });
  return `<nav class="files-index" id="files" aria-label="Files"><h2>Files (${placed.length})</h2><table><thead><tr><th>File</th><th>Change</th><th class="num">Lines</th><th class="num">Findings</th></tr></thead><tbody>${rows.join("")}</tbody></table></nav>`;
}

function findingsIndex(report: Report): string {
  const complete = report.completion === undefined || report.completion.status === "complete";
  const ordered = orderFindings(report.findings);
  const title = complete ? `Findings (${ordered.length})` : `Findings so far (the change was not fully reviewed) (${ordered.length})`;
  const empty = complete ? "No findings on the changed lines." : "None yet.";
  const items = ordered.map((f, i) => `<li id="index-${i + 1}" class="severity-${esc(f.severity)}"><a href="#finding-${i + 1}">${i + 1}</a><span class="severity">${esc(f.severity)}</span><span class="category">${line(f.category)}</span><span class="title">${line(f.title)}</span><span class="where">${line(location(f))}</span></li>`);
  const counts = [ordered.length > 0 ? `${plural(ordered.length, "finding", "findings")} (${severityBreakdown(ordered.map((f) => f.severity))})` : "no findings", `${plural(report.dropped.length, "scanner candidate", "scanner candidates")} dropped`];
  if (report.below_threshold > 0) counts.push(`${report.below_threshold} below the severity threshold`);
  return `<section class="findings-index" id="findings"><h2>${line(title)}</h2><p class="counts">Counts: ${line(counts.join(", "))}</p>${items.length > 0 ? `<ol>${items.join("")}</ol>` : `<p>${empty}</p>`}</section>`;
}

function candidateItem(c: Candidate): string {
  return `<li>${line(`${c.id} [${c.token}] ${candidateLocation(c)} (${c.reviewSeverity}): ${c.message}`)}</li>`;
}

function accounting(report: Report): string {
  const raised = report.findings.filter((f) => f.candidate !== null).length;
  const rows: [string, string][] = [
    ["Findings", `${report.findings.length}, ${raised} of them raised from scanner candidates`],
    ["Scanner candidates dropped", `${report.dropped.length}, each under the line it was dropped at, folded`],
    ["Below the severity threshold, not shown", String(report.below_threshold)],
    ["Below the confidence floor, not counted", String(report.low_confidence.length)],
  ];
  const parts = [`<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${line(v)}</dd>`).join("")}</dl>`];
  if (report.low_confidence.length > 0) {
    parts.push(`<h3>Below the confidence floor</h3><ul>${report.low_confidence.map((l) => `<li>${line(`${l.file_path}: ${l.title} (confidence ${l.confidence}, floor ${l.floor})`)}</li>`).join("")}</ul>`);
  }
  if (report.not_reviewed.length > 0) {
    parts.push(`<h3>Scanner candidates the reviewer did not check (counted)</h3><ul>${report.not_reviewed.map(candidateItem).join("")}</ul>`);
  }
  if (report.outside_change.length > 0) {
    parts.push(`<h3>Outside the changed lines (not counted)</h3><ul>${report.outside_change.map((f) => `<li>${line(`${location(f)}: ${f.title}`)}</li>`).join("")}</ul>`);
  }
  return `<section class="accounting" id="accounting"><h2>Review accounting</h2>${parts.join("")}</section>`;
}

function scannerRow(s: ScannerRunSummary): string {
  const cells = [s.scanner, s.status.replace(/_/g, " "), s.version ?? "", String(s.rawCount), String(s.keptCount), s.durationMs > 0 ? `${(s.durationMs / 1000).toFixed(1)} s` : "", s.reason ?? ""];
  return `<tr>${cells.map((v, i) => `<td${i >= 3 && i <= 5 ? ' class="num"' : ""}>${line(v)}</td>`).join("")}</tr>`;
}

function scanners(report: Report): string {
  return `<section class="scanners" id="scanners"><h2>Scanners</h2><p>${line(coverageLine(report.scanners))}</p><table><thead><tr><th>Scanner</th><th>Status</th><th>Version</th><th class="num">Found</th><th class="num">Kept</th><th class="num">Time</th><th>Reason</th></tr></thead><tbody>${report.scanners.map(scannerRow).join("")}</tbody></table></section>`;
}

function blastRadius(report: Report): string {
  const impact: ImpactSummary | null = report.impact;
  const open = '<section class="blast-radius" id="blast-radius"><h2>Blast radius</h2>';
  if (impact === null) return `${open}<p>Not traced: a review of the whole repository has no change to trace.</p></section>`;
  const summary = impactLine(report);
  if (impact.status === "off" || impact.status === "skipped" || impact.status === "failed") {
    return `${open}<p>${line(summary ?? `The code graph is ${impact.status}: ${impact.reasons.join("; ")}`)}</p></section>`;
  }
  const sym = new Map(impact.symbols.map((s) => [s.id, s]));
  const name = (id: string) => sym.get(id)?.name ?? id;
  const at = (id: string) => {
    const s = sym.get(id);
    return s ? `${s.file}:${s.startLine}` : "";
  };
  const parts = [`<p>${line(summary ?? "")}</p>`];
  if (impact.status === "partial") parts.push(`<p>Partial graph: ${line(impact.reasons.join("; "))}</p>`);
  const table = (title: string, heads: string[], rows: string[][]) =>
    rows.length === 0 ? "" : `<h3>${esc(title)}</h3><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${line(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  parts.push(table("Symbols the change touched", ["Symbol", "Kind", "Where"], impact.touched.map((id) => [name(id), sym.get(id)?.kind ?? "", at(id)])));
  parts.push(table("Symbols the change removed or moved", ["Symbol", "Kind", "Was at", "Now"], impact.removed.map((id) => {
    const s = sym.get(id);
    return [name(id), s?.kind ?? "", at(id), s?.movedTo ? `moved to ${s.movedTo.file}:${s.movedTo.line}` : "removed"];
  })));
  const last = (edges: ImpactEdge[]) => edges[edges.length - 1] as ImpactEdge;
  parts.push(table("Callers", ["Touched symbol", "Caller", "Call sites"], impact.callers.map((p) => {
    const edge = last(p.edges);
    return [name(p.seed), `${name(edge.from)}${p.edges.length > 1 ? " (two calls away)" : ""}`, edge.sites.map((s) => `${s.file}:${s.line}`).join(", ")];
  })));
  parts.push(table("Files that import a changed file", ["File", "Imports"], impact.importers.map((e) => [sym.get(e.from)?.file ?? e.from, sym.get(e.to)?.file ?? e.to])));
  const cut = [impact.truncated.walk ? "the walk of callers stopped at its bound" : "", impact.truncated.omittedSites ? `${impact.truncated.omittedSites} call sites left out` : ""].filter((x) => x !== "");
  if (cut.length > 0) parts.push(`<p>${line(`Cut short: ${cut.join("; ")}.`)}</p>`);
  return `${open}${parts.join("")}</section>`;
}

function footer(report: Report, input: HtmlInput): string {
  return [
    '<footer class="footer">',
    `<p>${line(reviewerLine(report.completion?.reviewer ?? null))}</p>`,
    `<p>Written by openqodex ${line(input.version)}. report.md and report.json are in the same folder as this page.</p>`,
    "<p>To fix findings, tell your coding agent which ones by number, for example: fix 1 and 3. It reads them in full with openqodex findings 1,3.</p>",
    "<p>This page runs no script and loads nothing. Opening it sends nothing anywhere.</p>",
    `<p>${esc(CLOSING)}</p>`,
    "</footer>",
  ].join("");
}

export function renderHtml(input: HtmlInput): string {
  const { report } = input;
  const files = input.display?.files ?? [];
  const placed = place(report, files);
  const complete = report.completion === undefined || report.completion.status === "complete";
  const title = complete ? verdictLine(report) : "Review incomplete";
  const summary = report.summary !== null && report.summary.trim() !== "" ? `<section class="summary" id="summary"><h2>Summary</h2><p>${line(report.summary)}</p></section>` : "";
  const noCode = input.display === null ? '<p class="file-note">The code of this review was not saved, so the findings are shown by file without it.</p>' : "";
  const body = [
    header(report, input),
    "<main>",
    summary,
    coverage(report),
    filesIndex(placed, report),
    findingsIndex(report),
    `<section class="changes" id="changes"><h2>${input.display?.kind === "excerpts" ? "Findings by file" : "Changes"}</h2>${noCode}${placed.map(fileSection).join("")}</section>`,
    accounting(report),
    scanners(report),
    blastRadius(report),
    "</main>",
    footer(report, input),
  ].join("\n");
  return page(`OpenQodex review: ${title}`, body);
}

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy(REPORT_CSS)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${line(title)}</title>`,
    `<style>${REPORT_CSS}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// The page of a review that never started: no reviewer could. It is not a
// review and says so; the unchecked scanner candidates are in their own file.
export function renderUnavailableHtml(input: { changeId: string; reasons: string[]; candidatesPath: string; fallback: string; version: string }): string {
  const body = [
    '<header class="header" id="top">',
    '<p class="product">OpenQodex review</p>',
    '<h1 class="verdict verdict-incomplete">Full review unavailable: openqodex could not start a reviewer</h1>',
    `<dl class="facts"><div><dt>Change</dt><dd>${line(input.changeId.slice(0, 12))}</dd></div></dl>`,
    "</header>",
    "<main>",
    `<section class="missing"><h2>Why</h2><ul>${input.reasons.map((r) => `<li>${line(r)}</li>`).join("")}</ul></section>`,
    `<section class="coverage"><h2>What there is</h2><dl><dt>Unchecked scanner candidates, not a review</dt><dd>${line(input.candidatesPath)}</dd><dt>To review with the agent you are in</dt><dd><code>${line(input.fallback)}</code></dd></dl></section>`,
    "</main>",
    `<footer class="footer"><p>Written by openqodex ${line(input.version)}.</p><p>This page runs no script and loads nothing. Opening it sends nothing anywhere.</p></footer>`,
  ].join("\n");
  return page("OpenQodex review: unavailable", body);
}
