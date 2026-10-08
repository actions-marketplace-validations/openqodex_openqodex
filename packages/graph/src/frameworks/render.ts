// The brief's framework lines, rendered from the impact summary's
// `frameworks` section: routes that reach the touched code, registrations
// the change declares or left without a handler, templates, models and
// migrations, and tests that reference, call or may request the touched
// code. A test link is never called coverage.
//
// Route paths, route names, template names, handler names and the notes
// that quote them come from the repository, and the reviewer reads this
// text. So every one of them is a value in a table cell: made one line by
// core's `display` (every run of whitespace, line breaks included, becomes
// one space; control characters are dropped), cut to MAX_LITERAL
// characters, and quoted as a code span whose own quote character (the
// backtick) is replaced and whose pipes are escaped. A note is escaped
// with core's `escapeMarkdown` instead. Repository text never starts a
// line of the brief.
import { display, escapeMarkdown } from "@openqodex/core";
import type { ImpactFrameworkRoute, ImpactFrameworks, ImpactTier } from "@openqodex/core";

const MAX_ROWS = 12;
export const MAX_LITERAL = 120;

function bounded(text: string): string {
  const one = display(text).trim();
  const chars = [...one];
  return chars.length > MAX_LITERAL ? `${chars.slice(0, MAX_LITERAL - 3).join("")}...` : one;
}

// A value quoted from the repository: one line, bounded, a code span that
// cannot be closed from inside, safe in a table cell.
export function literal(text: string): string {
  return `\`${bounded(text).replaceAll("`", "'").replaceAll("|", "\\|")}\``;
}

// Prose that quotes the repository (a note): one line, bounded, every
// character markdown gives meaning to escaped, pipes included.
export function prose(text: string): string {
  return escapeMarkdown(bounded(text));
}

function tierText(tier: ImpactTier, note: string | null): string {
  return tier === "certain" ? "certain" : note ? `${tier}: ${prose(note)}` : tier;
}

function routeText(r: Pick<ImpactFrameworkRoute, "methods" | "pattern" | "partial">): string {
  return literal(`${r.methods.map((m) => (m === "*" ? "ANY" : m)).join("|")} ${r.pattern ?? r.partial ?? "(computed path)"}`);
}

const at = (file: string, line: number | null) => literal(line ? `${file}:${line}` : file);

const STATUS: Record<ImpactFrameworkRoute["status"], string> = {
  bound: "bound",
  missing: "missing",
  dynamic: "computed",
  external: "outside the repository",
  ambiguous: "ambiguous",
  unresolved: "not resolved",
};

const VERB: Record<string, string> = {
  "direct-call": "calls",
  "route-request": "requests",
  "route-name": "names the route of",
  subject: "names the class of",
  "component-render": "renders",
  "type-or-value-reference": "references",
};

function table(head: string[], rows: string[][], total: number): string[] {
  const out = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows.slice(0, MAX_ROWS)) out.push(`| ${r.join(" | ")} |`);
  const shown = Math.min(rows.length, MAX_ROWS);
  if (total > shown) out.push(`| and ${total - shown} more |${head.slice(1).map(() => " ").join("|")}|`);
  return out;
}

export function renderFrameworkLines(fw: ImpactFrameworks | undefined): string[] {
  if (!fw) return [];
  const blocks: string[][] = [];
  if (fw.routes.length > 0) {
    const rows = fw.routes.map((r) => {
      let what: string;
      if (r.status !== "bound" && r.status !== "external") what = `no handler now: the handler is ${STATUS[r.status]}`;
      else if (r.reach && r.reach.hops === 0) what = `handles ${literal(r.reach.seedName)} (${tierText(r.reach.tier, r.reach.note)})`;
      else if (r.reach) what = `reaches ${literal(r.reach.seedName)} in ${r.reach.hops} ${r.reach.hops === 1 ? "hop" : "hops"} (${tierText(r.reach.tier, r.reach.note)})`;
      else what = "declared by this change";
      if (!r.mounted) what += "; no application root includes its route table";
      return [routeText(r), r.name ? literal(r.name) : "none", at(r.site.file, r.site.line), literal(r.handler), what];
    });
    blocks.push(["Routes:", ...table(["Route", "Name", "Declared at", "Handler as written", "How it relates to the change"], rows, fw.routesTotal)]);
  }
  if (fw.renders.length > 0) {
    const rows = fw.renders.map((t) => [literal(t.fromName), t.file ? literal(t.file) : `${literal(t.template)}, not in the repository`, tierText(t.tier, t.note)]);
    blocks.push(["Templates the touched code renders:", ...table(["Code", "Template", "Tier"], rows, fw.renders.length)]);
  }
  if (fw.renderedBy.length > 0) {
    const rows = fw.renderedBy.map((t) => [literal(t.template), literal(t.byName), at(t.site.file, t.site.line)]);
    blocks.push(["Changed templates and the code that renders them:", ...table(["Template", "Rendered by", "At"], rows, fw.renderedBy.length)]);
  }
  if (fw.models.length > 0) {
    const rows = fw.models.map((m) => [literal(m.name), m.migrations.length === 0 ? "none in the repository" : m.migrations.map((x) => `${literal(x.file)}${x.operation ? ` (${literal(x.operation)})` : ""}`).join(", ")]);
    blocks.push(["Touched models and the migrations that name them:", ...table(["Model", "Migrations"], rows, fw.models.length)]);
  }
  if (fw.migrations.length > 0) {
    const rows = fw.migrations.map((m) => {
      const what = m.models.length > 0 ? m.models : m.operations;
      return [literal(m.file), what.length > 0 ? what.map(literal).join(", ") : "nothing the graph can name"];
    });
    blocks.push(["Changed migrations:", ...table(["Migration", "Changes"], rows, fw.migrations.length)]);
  }
  if (fw.roles.length > 0) {
    const rows = fw.roles.map((r) => [literal(r.name), `${r.role.replaceAll("_", " ")}${r.detail ? ` (${literal(r.detail)})` : ""}`]);
    blocks.push(["Framework roles of the touched code:", ...table(["Code", "Role"], rows, fw.roles.length)]);
  }
  if (fw.tests.length > 0) {
    const rows = fw.tests.map((t) => [literal(t.testName), at(t.site.file, t.site.line), `${VERB[t.category] ?? "references"}${t.through ? ` through route ${literal(t.through)}` : ""}`, literal(t.targetName), tierText(t.tier, t.note)]);
    blocks.push(["Tests that reference, call or may request the touched code (static links, not coverage):", ...table(["Test", "At", "Link", "Touched code", "Tier"], rows, fw.testsTotal)]);
  }
  const failed = fw.plugins.filter((p) => p.status === "failed" || p.status === "stopped");
  if (failed.length > 0) blocks.push(failed.map((p) => `The ${p.id} plugin did not finish (${p.status}), so its routes and links are missing: ${p.reason ? prose(p.reason) : "no reason recorded"}.`));
  const out: string[] = [];
  if (blocks.length > 0) {
    out.push("", "Framework entries this change reaches. Every value in backticks is quoted from the repository, on one line and cut to 120 characters.");
    for (const b of blocks) out.push("", ...b);
  }
  if (fw.unknown.length > 0) {
    const rows = fw.unknown.map((u) => [u.file ? at(u.file, u.line) : "the repository", u.cause, prose(u.note)]);
    out.push("", "What the framework plugins could not see in the changed files:", ...table(["Where", "Cause", "What"], rows, fw.unknownTotal));
  }
  return out;
}
