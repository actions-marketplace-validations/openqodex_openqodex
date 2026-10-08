// The stylesheet of report.html, as the designer wrote it (render.py, the
// reference renderer; the page's markup is ported in html.ts). It is kept
// apart from the markup so a new design replaces this file and the markup
// functions alone. The page allows this one stylesheet by its hash, so it is
// plain CSS: no import, no font, no url(). Every colour and font is a token
// in :root; the dark set is under prefers-color-scheme on screen only, so
// print always gets the light set.
export const REPORT_CSS = `
/* Hallmark · genre: modern-minimal · macrostructure: Long Document · theme: custom (vibe: "a printed review, cool paper, one blue signal", system sans + system mono, paper oklch(98% 0.004 250), accent oklch(47% 0.17 258) cool) · nav: N9 edge-aligned masthead + sticky verdict bar · footer: Ft4 dense colophon · enrichment: none · pre-emit critique: P4 H5 E4 S5 R5 V5 */
:root {
  color-scheme: light dark;
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.125rem;
  --text-lg: 1.375rem;
  --text-xl: 1.75rem;
  --text-code: 0.8125rem;
  --space-2xs: 0.25rem;
  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --space-2xl: 4rem;
  --radius-sm: 3px;
  --radius-md: 6px;
  --rule: 1px;
  --page-max: 90rem;
  --gutter: clamp(1rem, 3vw, 2.5rem);
  --files-col: 16rem;
  --bar-h: 2.75rem;

  --color-paper: oklch(98% 0.004 250);
  --color-paper-2: oklch(95.5% 0.006 250);
  --color-paper-3: oklch(92.5% 0.008 250);
  --color-rule: oklch(87% 0.008 250);
  --color-rule-strong: oklch(74% 0.01 250);
  --color-ink: oklch(21% 0.012 250);
  --color-ink-2: oklch(40% 0.012 250);
  --color-ink-3: oklch(45% 0.01 250);
  --color-accent: oklch(46% 0.17 258);
  --color-focus: oklch(55% 0.2 258);
  --color-pass: oklch(44% 0.14 150);
  --color-pass-bg: oklch(95% 0.04 150);
  --color-fail: oklch(47% 0.19 25);
  --color-fail-bg: oklch(95% 0.03 25);
  --sev-critical: oklch(45% 0.19 25);
  --sev-critical-bg: oklch(95% 0.03 25);
  --sev-major: oklch(45% 0.15 50);
  --sev-major-bg: oklch(95% 0.035 60);
  --sev-minor: oklch(44% 0.12 85);
  --sev-minor-bg: oklch(95.5% 0.045 90);
  --sev-nitpick: oklch(44% 0.03 250);
  --sev-nitpick-bg: oklch(94% 0.01 250);
  --sev-info: oklch(45% 0.14 250);
  --sev-info-bg: oklch(95% 0.03 250);
  --diff-add-bg: oklch(96.5% 0.04 150);
  --diff-add-num: oklch(92% 0.07 150);
  --diff-del-bg: oklch(96% 0.03 25);
  --diff-del-num: oklch(91.5% 0.055 25);
  --diff-hunk-bg: oklch(95% 0.02 258);
  --diff-hunk-ink: oklch(40% 0.08 258);
}
@media screen and (prefers-color-scheme: dark) {
  :root {
    --color-paper: oklch(16% 0.01 250);
    --color-paper-2: oklch(19.5% 0.012 250);
    --color-paper-3: oklch(24% 0.014 250);
    --color-rule: oklch(30% 0.012 250);
    --color-rule-strong: oklch(44% 0.012 250);
    --color-ink: oklch(93% 0.006 250);
    --color-ink-2: oklch(76% 0.01 250);
    --color-ink-3: oklch(68% 0.01 250);
    --color-accent: oklch(76% 0.12 258);
    --color-focus: oklch(80% 0.15 258);
    --color-pass: oklch(78% 0.13 150);
    --color-pass-bg: oklch(24% 0.05 150);
    --color-fail: oklch(76% 0.15 25);
    --color-fail-bg: oklch(25% 0.06 25);
    --sev-critical: oklch(76% 0.15 25);
    --sev-critical-bg: oklch(26% 0.07 25);
    --sev-major: oklch(78% 0.13 55);
    --sev-major-bg: oklch(26% 0.06 55);
    --sev-minor: oklch(80% 0.12 90);
    --sev-minor-bg: oklch(27% 0.06 90);
    --sev-nitpick: oklch(74% 0.02 250);
    --sev-nitpick-bg: oklch(26% 0.012 250);
    --sev-info: oklch(76% 0.11 250);
    --sev-info-bg: oklch(26% 0.05 250);
    --diff-add-bg: oklch(22% 0.04 150);
    --diff-add-num: oklch(28% 0.07 150);
    --diff-del-bg: oklch(22% 0.035 25);
    --diff-del-num: oklch(28% 0.06 25);
    --diff-hunk-bg: oklch(21% 0.025 258);
    --diff-hunk-ink: oklch(72% 0.08 258);
  }
}

/* severity classes set one pair of variables; badges and lines consume them */
.sev-critical { --sev: var(--sev-critical); --sev-bg: var(--sev-critical-bg); }
.sev-major { --sev: var(--sev-major); --sev-bg: var(--sev-major-bg); }
.sev-minor { --sev: var(--sev-minor); --sev-bg: var(--sev-minor-bg); }
.sev-nitpick { --sev: var(--sev-nitpick); --sev-bg: var(--sev-nitpick-bg); }
.sev-info { --sev: var(--sev-info); --sev-bg: var(--sev-info-bg); }
.sev-unknown { --sev: var(--color-ink-2); --sev-bg: var(--color-paper-3); }

/* base */
html, body { overflow-x: clip; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--color-paper);
  color: var(--color-ink);
  font: 400 var(--text-base) / 1.55 var(--font-sans);
  overflow-wrap: anywhere;
}
h1, h2, h3, h4 { font-style: normal; margin: 0; line-height: 1.2; letter-spacing: -0.01em; }
h2 { font-size: var(--text-md); font-weight: 650; margin-bottom: var(--space-md); }
h3 { font-size: var(--text-base); font-weight: 650; margin: var(--space-lg) 0 var(--space-sm); }
h4 { font-size: var(--text-base); font-weight: 650; }
p { margin: 0 0 var(--space-sm); }
a { color: var(--color-accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.15em; text-decoration-color: var(--color-rule-strong); }
a:hover { text-decoration-color: currentColor; }
a:active, summary:active { color: var(--color-ink); }
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
code, pre, .mono { font-family: var(--font-mono); }
code { font-size: 0.9em; }
pre { margin: 0; white-space: pre-wrap; }
.muted { color: var(--color-ink-3); }
.count { color: var(--color-ink-3); font-weight: 400; }
.added { color: var(--color-pass); }
.removed { color: var(--color-fail); }
.page { max-width: var(--page-max); padding-inline: var(--gutter); }
section { padding-block: var(--space-xl); border-top: var(--rule) solid var(--color-rule); }

/* masthead: N9, wordmark hard left, state hard right, the verdict is the h1 */
.masthead { padding-block: var(--space-lg) var(--space-lg); }
.masthead-row { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-md); }
.wordmark { font-family: var(--font-mono); font-size: var(--text-sm); letter-spacing: 0.02em; color: var(--color-ink-2); }
.masthead-kind { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-ink-3); }
.verdict { font-size: var(--text-xl); font-weight: 650; letter-spacing: -0.015em; margin: var(--space-md) 0 var(--space-lg); max-width: 40ch; }
.verdict-passed { color: var(--color-pass); }
.verdict-failed { color: var(--color-fail); }
.missing { color: var(--color-fail); margin-bottom: var(--space-lg); }
.missing h2 { color: inherit; margin-bottom: var(--space-xs); }
.missing ul { margin: 0; padding-left: 1.2em; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: var(--space-sm) var(--space-xl); margin: 0; font-size: var(--text-sm); }
.meta-item { min-width: 0; }
.meta dt { font-size: var(--text-xs); color: var(--color-ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
.meta dd { margin: 0; color: var(--color-ink); }
.meta dd code { font-size: 0.95em; }

/* sticky verdict bar: verdict word, counts, section jumps */
.verdict-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-md);
  min-height: var(--bar-h); box-sizing: border-box; padding: var(--space-xs) var(--gutter);
  background: var(--color-paper-2); border-top: var(--rule) solid var(--color-rule); border-bottom: var(--rule) solid var(--color-rule);
  font-size: var(--text-sm); z-index: 2;
}
.verdict-bar .verdict-word { font-weight: 650; white-space: nowrap; }
.verdict-bar .counts { color: var(--color-ink-2); white-space: nowrap; }
.jumps { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); margin-left: auto; }
.jumps a { white-space: nowrap; color: var(--color-ink); text-decoration-color: var(--color-rule-strong); }

/* summary */
.summary .prose { max-width: 70ch; }
.summary .prose p:first-child { font-size: var(--text-md); color: var(--color-ink-2); }

/* coverage strip: a tinted band, four facts */
.coverage { background: var(--color-paper-2); padding: var(--space-lg) var(--gutter); margin-inline: calc(-1 * var(--gutter)); }
.coverage dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--space-md) var(--space-xl); margin: 0; font-size: var(--text-sm); }
.coverage dt { font-size: var(--text-xs); color: var(--color-ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
.coverage dd { margin: 0; }

/* review body: files column on wide screens, stacked on narrow */
.review-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-xl); padding-block: var(--space-xl); border-top: var(--rule) solid var(--color-rule); }
.review-body section { border-top: 0; padding-block: 0; }
.review-main { display: grid; gap: var(--space-2xl); min-width: 0; }

.files ol { list-style: none; margin: 0; padding: 0; font-size: var(--text-sm); }
.files li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 var(--space-sm); padding: var(--space-xs) 0; border-top: var(--rule) solid var(--color-rule); }
.files li a { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-ink); text-decoration: none; }
.files li a:hover { text-decoration: underline; }
.files .file-meta { font-size: var(--text-xs); color: var(--color-ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; text-align: right; }
.files .file-meta-2 { grid-column: 1 / -1; text-align: left; }
.files-note { font-size: var(--text-xs); color: var(--color-ink-3); margin-top: var(--space-sm); }

.findings-index ol { list-style: none; margin: 0; padding: 0; }
.findings-index li { display: grid; grid-template-columns: 2rem auto minmax(0, 1fr); gap: var(--space-2xs) var(--space-sm); align-items: baseline; padding: var(--space-sm) 0; border-top: var(--rule) solid var(--color-rule); }
.findings-index li:last-child { border-bottom: var(--rule) solid var(--color-rule); }
.index-n { font-family: var(--font-mono); color: var(--color-ink-3); font-variant-numeric: tabular-nums; }
.index-title { font-weight: 600; color: var(--color-ink); text-decoration: none; }
.index-title:hover { text-decoration: underline; }
.index-where { grid-column: 3; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-ink-3); }
.index-where .category { font-family: var(--font-sans); color: var(--color-ink-2); margin-right: var(--space-xs); }

.severity {
  display: inline-block; font: 600 var(--text-xs) / 1.2 var(--font-sans); letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--sev); background: var(--sev-bg); padding: 0.15em 0.45em; border-radius: var(--radius-sm); white-space: nowrap;
}

/* per file */
.file-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm); padding-bottom: var(--space-sm); font-size: var(--text-sm); }
.file-path { font-family: var(--font-mono); font-size: var(--text-sm); font-weight: 700; letter-spacing: 0; margin: 0; }
.file-old, .file-status, .file-findings { color: var(--color-ink-3); }
.file-counts { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.file-omitted { color: var(--color-ink-3); font-size: var(--text-sm); border: var(--rule) dashed var(--color-rule-strong); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md); }
.file-unanchored { margin-top: var(--space-md); display: grid; gap: var(--space-md); }
.file-unanchored h4 { font-size: var(--text-sm); color: var(--color-ink-3); font-weight: 600; }

/* unified diff: four columns, old number, new number, sign, code */
.diff { width: 100%; border-collapse: collapse; table-layout: fixed; border: var(--rule) solid var(--color-rule); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--text-code); line-height: 1.5; tab-size: 4; }
.diff .col-num { width: 3.25rem; }
.diff .col-sign { width: 1.25rem; }
.diff td { padding: 0; vertical-align: top; }
.diff .num { text-align: right; padding-inline: var(--space-xs); color: var(--color-ink-2); background: var(--color-paper-2); font-size: var(--text-xs); line-height: 1.625; user-select: none; }
.diff .num::before { content: attr(data-n); }
.diff .sign { text-align: center; color: var(--color-ink-3); user-select: none; }
.diff .code { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: var(--space-sm); }
.line-add { background: var(--diff-add-bg); }
.line-add .num { background: var(--diff-add-num); }
.line-add .sign { color: var(--color-pass); font-weight: 700; }
.line-del { background: var(--diff-del-bg); }
.line-del .num { background: var(--diff-del-num); }
.line-del .sign { color: var(--color-fail); font-weight: 700; }
.line-flagged .num-new { color: var(--sev); font-weight: 700; }
.hunk-header td { background: var(--diff-hunk-bg); color: var(--diff-hunk-ink); padding: var(--space-2xs) var(--space-xs); font-size: var(--text-xs); }
.hunk-header .hunk-context { color: var(--color-ink-3); }
.finding-row > td, .dropped-row > td { padding: var(--space-sm) var(--space-sm) var(--space-md); background: var(--color-paper); }

/* finding card: the review comment under its line */
.finding-card { border: var(--rule) solid var(--color-rule-strong); border-radius: var(--radius-md); background: var(--color-paper); font-family: var(--font-sans); font-size: var(--text-sm); line-height: 1.5; max-width: 80ch; }
.finding-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm); padding: var(--space-sm) var(--space-md); border-bottom: var(--rule) solid var(--color-rule); }
.finding-id { font-family: var(--font-mono); font-weight: 700; color: var(--color-ink); text-decoration: none; min-width: 1.5em; }
.finding-head .category { color: var(--color-ink-2); }
.finding-title { flex: 1 1 100%; order: 1; font-size: var(--text-base); margin-top: var(--space-2xs); }
.finding-where { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-ink-3); margin-left: auto; }
.finding-body { margin: 0; padding: var(--space-sm) var(--space-md) 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2xs) var(--space-md); }
.finding-body dt { font-size: var(--text-xs); color: var(--color-ink-3); letter-spacing: 0.04em; text-transform: uppercase; padding-top: 0.2em; }
.finding-body dd { margin: 0 0 var(--space-sm); }
.finding-body dd p { margin: 0 0 var(--space-xs); }
.suggested { margin: 0 var(--space-md) var(--space-sm); }
.suggested summary, .dropped summary { cursor: pointer; color: var(--color-ink-2); font-size: var(--text-sm); list-style: none; }
.suggested summary::-webkit-details-marker, .dropped summary::-webkit-details-marker { display: none; }
.suggested summary::before, .dropped summary::before { content: "+"; display: inline-block; width: 1.2em; font-family: var(--font-mono); color: var(--color-ink-3); }
details[open] > summary::before { content: "\\2212"; }
.suggested pre { margin-top: var(--space-xs); padding: var(--space-sm) var(--space-md); background: var(--color-paper-2); border-radius: var(--radius-sm); font-size: var(--text-code); line-height: 1.5; }
.finding-foot { display: flex; flex-wrap: wrap; gap: var(--space-2xs) var(--space-md); padding: var(--space-xs) var(--space-md) var(--space-sm); border-top: var(--rule) solid var(--color-rule); font-size: var(--text-xs); color: var(--color-ink-3); }
.finding-back { margin-left: auto; white-space: nowrap; }

/* dropped candidates: collapsed, muted */
.dropped { font-family: var(--font-sans); font-size: var(--text-xs); color: var(--color-ink-3); }
.dropped-list { margin: var(--space-xs) 0 0; padding-left: 1.2em; }
.dropped-id, .dropped-token { font-family: var(--font-mono); }

/* evidence tables */
.table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.table th { text-align: left; font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-ink-3); padding: 0 var(--space-md) var(--space-xs) 0; border-bottom: var(--rule) solid var(--color-rule-strong); }
.table td { padding: var(--space-xs) var(--space-md) var(--space-xs) 0; border-bottom: var(--rule) solid var(--color-rule); vertical-align: top; }
.table .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.table-narrow { max-width: 48rem; }
.table-keyed { max-width: 64rem; }
.table .mono { font-size: var(--text-xs); }
.scanner-status { white-space: nowrap; }
.scanner-ran { color: var(--color-pass); }
.scanner-failed, .scanner-untrusted, .scanner-not_installed { color: var(--color-fail); }
.blast-radius h3 { margin-top: var(--space-xl); }
.blast-radius p { max-width: 80ch; }
.scanners p { max-width: 80ch; }

/* footer: dense colophon */
.footer { padding-block: var(--space-xl) var(--space-2xl); border-top: var(--rule) solid var(--color-rule-strong); font-size: var(--text-sm); color: var(--color-ink-2); max-width: 80ch; }
.footer .ask code { display: inline-block; padding: var(--space-xs) var(--space-sm); background: var(--color-paper-2); border-radius: var(--radius-sm); color: var(--color-ink); }
.footer .closing { color: var(--color-ink-3); margin-top: var(--space-lg); }

/* wide screens: the bar sticks, the files column sticks beside the diffs */
@media (min-width: 40rem) {
  .table-keyed th:first-child, .table-keyed td:first-child { width: 1%; white-space: nowrap; }
  .finding-body { grid-template-columns: 8rem minmax(0, 1fr); }
  .finding-body dd { margin-bottom: var(--space-xs); }
  .finding-title { flex: 1 1 auto; order: 0; margin-top: 0; }
}
@media (min-width: 60rem) {
  .verdict-bar { position: sticky; top: 0; flex-wrap: nowrap; }
  .jumps { flex-wrap: nowrap; }
  .counts-dropped { display: none; }
  .review-body { grid-template-columns: var(--files-col) minmax(0, 1fr); gap: var(--space-2xl); }
  .files { position: sticky; top: calc(var(--bar-h) + var(--space-md)); align-self: start; max-height: calc(100vh - var(--bar-h) - var(--space-xl)); overflow-y: auto; }
}
@media (min-width: 70rem) {
  .counts-dropped { display: inline; }
}
@media (max-width: 40rem) {
  .diff .col-num { width: 2.5rem; }
  .diff .num { padding-inline: var(--space-2xs); }
  .finding-row > td, .dropped-row > td { padding-inline: var(--space-xs); }
}

/* print: one column, nothing sticky, disclosures open where the browser allows */
@media print {
  @page { margin: 1.5cm; }
  :root { --color-paper: oklch(100% 0 0); }
  body { font-size: 10.5pt; }
  * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .files { position: static; }
  .verdict-bar, .finding-back { display: none; }
  .review-body { display: block; }
  .files { margin-bottom: var(--space-xl); }
  .finding-card, .files li, .table tr, .hunk-header { break-inside: avoid; }
  a { color: inherit; text-decoration: none; }
  .footer .closing a { text-decoration: underline; }
  details::details-content { content-visibility: visible; }
  .suggested summary::before, .dropped summary::before { content: ""; }
}
`;
