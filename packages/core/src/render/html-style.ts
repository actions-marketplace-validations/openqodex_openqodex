// The stylesheet of report.html, kept apart from the markup so a new design
// replaces this file alone. The page allows this one stylesheet by its hash
// (html.ts), so it is plain CSS: no import, no font, no url().
//
// Class names say what each part is: header, verdict, summary, coverage,
// files-index, findings-index, file, hunk, line, finding-card, dropped,
// accounting, scanners, blast-radius, footer.
export const REPORT_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #59636e;
  --line: #d1d9e0;
  --panel: #f6f8fa;
  --link: #0a5bd3;
  --add-bg: #e6ffec;
  --add-num: #ccffd8;
  --del-bg: #ffebe9;
  --del-num: #ffd7d5;
  --hunk-bg: #ddf4ff;
  --critical: #b3261e;
  --major: #c4320a;
  --minor: #8a6100;
  --nitpick: #4c6a8c;
  --info: #59636e;
  --passed: #1a7f37;
  --blocked: #b3261e;
  --incomplete: #b3261e;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #9198a1;
    --line: #3d444d;
    --panel: #151b23;
    --link: #4493f8;
    --add-bg: #12261e;
    --add-num: #1b4721;
    --del-bg: #25171c;
    --del-num: #542426;
    --hunk-bg: #121d2f;
    --critical: #ff7b72;
    --major: #ffa657;
    --minor: #d29922;
    --nitpick: #79c0ff;
    --info: #9198a1;
    --passed: #3fb950;
    --blocked: #ff7b72;
    --incomplete: #ff7b72;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--sans); }
a { color: var(--link); }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
main, .footer { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
h2 { font-size: 18px; margin: 32px 0 8px; }
h3 { font-size: 15px; margin: 0; }
code, pre { font-family: var(--mono); font-size: 12px; }
table { border-collapse: collapse; }
.header { position: sticky; top: 0; z-index: 1; background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 16px; }
.header .product { margin: 0; color: var(--muted); font-size: 12px; }
.verdict { margin: 2px 0 6px; font-size: 20px; }
.verdict-passed { color: var(--passed); }
.verdict-blocked, .verdict-incomplete { color: var(--blocked); }
.facts { display: flex; flex-wrap: wrap; gap: 4px 20px; margin: 0; color: var(--muted); font-size: 12px; }
.facts div { display: flex; gap: 6px; }
.facts dt { font-weight: 600; }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.missing { margin: 8px 0 0; color: var(--incomplete); }
.missing h2 { font-size: 14px; margin: 0; }
.missing ul { margin: 4px 0 0; padding-left: 20px; }
.summary p { max-width: 80ch; }
.coverage dl, .finding-body, .dropped dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.coverage dt, .finding-body dt, .dropped dt { color: var(--muted); }
.coverage dd, .finding-body dd, .dropped dd { margin: 0; overflow-wrap: anywhere; }
.files-index table, .scanners table, .blast-radius table, .accounting table { width: 100%; font-size: 13px; }
.files-index th, .files-index td, .scanners th, .scanners td, .blast-radius th, .blast-radius td, .accounting th, .accounting td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.num { text-align: right; white-space: nowrap; }
.findings-index ol { list-style: none; padding: 0; margin: 0; }
.findings-index li { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.severity { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
.severity-critical .severity, .severity.severity-critical { color: var(--critical); }
.severity-major .severity, .severity.severity-major { color: var(--major); }
.severity-minor .severity, .severity.severity-minor { color: var(--minor); }
.severity-nitpick .severity, .severity.severity-nitpick { color: var(--nitpick); }
.severity-info .severity, .severity.severity-info { color: var(--info); }
.category, .where { color: var(--muted); }
.file { margin: 24px 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.file-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
.file-head .path { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
.file-status, .file-stats { color: var(--muted); font-size: 12px; }
.file-note { margin: 0; padding: 8px 12px; color: var(--muted); }
.file-findings { padding: 8px 12px; border-bottom: 1px solid var(--line); }
.file-findings h4 { margin: 0 0 8px; font-size: 13px; color: var(--muted); }
.diff-scroll { overflow-x: auto; }
.diff { width: 100%; font-family: var(--mono); font-size: 12px; }
.hunk-head td { background: var(--hunk-bg); color: var(--muted); padding: 4px 12px; }
.line td { padding: 0 8px; vertical-align: top; }
.line .num { width: 1%; color: var(--muted); user-select: none; }
.line .sign { width: 1%; user-select: none; }
.line .text { white-space: pre; }
.line-add { background: var(--add-bg); }
.line-add .num { background: var(--add-num); }
.line-del { background: var(--del-bg); }
.line-del .num { background: var(--del-num); }
.line-note { color: var(--muted); font-style: italic; }
.comments td { padding: 8px 12px; font-family: var(--sans); font-size: 14px; white-space: normal; background: var(--bg); }
.finding-card { border: 1px solid var(--line); border-left-width: 4px; border-radius: 6px; padding: 10px 12px; margin: 0 0 8px; max-width: 90ch; background: var(--bg); }
.finding-card.severity-critical { border-left-color: var(--critical); }
.finding-card.severity-major { border-left-color: var(--major); }
.finding-card.severity-minor { border-left-color: var(--minor); }
.finding-card.severity-nitpick { border-left-color: var(--nitpick); }
.finding-card.severity-info { border-left-color: var(--info); }
.finding-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-bottom: 6px; }
.finding-head h4 { margin: 0; font-size: 14px; }
.finding-id { font-weight: 700; }
.suggested pre { background: var(--panel); padding: 8px; overflow-x: auto; margin: 6px 0 0; white-space: pre; }
.dropped { margin: 0 0 8px; color: var(--muted); max-width: 90ch; }
.dropped summary { cursor: pointer; }
.dropped dl { margin-top: 6px; }
.accounting ul { padding-left: 20px; }
.footer { color: var(--muted); font-size: 12px; padding-top: 16px; padding-bottom: 32px; border-top: 1px solid var(--line); margin-top: 32px; }
.footer p { margin: 4px 0; }
@media (max-width: 700px) {
  .facts { display: block; }
  .line .text { white-space: pre-wrap; overflow-wrap: anywhere; }
}
@media print {
  .header { position: static; }
  .diff-scroll { overflow: visible; }
  .line .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  details { display: block; }
  a { color: inherit; text-decoration: none; }
}
`;
