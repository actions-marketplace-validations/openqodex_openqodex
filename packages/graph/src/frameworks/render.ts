// The brief's framework lines, rendered from the impact summary's
// `frameworks` section: routes that reach the touched code, registrations
// the change declares or left without a handler, templates, models and
// migrations, and tests that reference, call or may request the touched
// code. A test link is never called coverage.
import type { ImpactFrameworkRoute, ImpactFrameworks, ImpactTier } from "@openqodex/core";

const MAX_LINES = 12;

function tierText(tier: ImpactTier, note: string | null): string {
  return tier === "certain" ? "certain" : note ? `${tier}: ${note}` : tier;
}

function methods(r: Pick<ImpactFrameworkRoute, "methods">): string {
  return r.methods.map((m) => (m === "*" ? "ANY" : m)).join("|");
}

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

export function renderFrameworkLines(fw: ImpactFrameworks | undefined): string[] {
  if (!fw) return [];
  const out: string[] = [];
  const more = (shown: number, total: number) => {
    if (total > shown) out.push(`- and ${total - shown} more`);
  };
  for (const r of fw.routes.slice(0, MAX_LINES)) {
    const head = `- Route ${methods(r)} ${r.pattern ?? "(computed path)"}${r.name ? ` named ${r.name}` : ""} (${r.site.file}:${r.site.line})`;
    const unmounted = r.mounted ? "" : "; no application root includes its route table";
    if (r.status !== "bound" && r.status !== "external") {
      out.push(`${head} has no handler now: \`${r.handler}\` is ${STATUS[r.status]}${unmounted}`);
      continue;
    }
    const reach = r.reach ? (r.reach.hops === 0 ? ` (${tierText(r.reach.tier, r.reach.note)})` : `, which reaches \`${r.reach.seedName}\` in ${r.reach.hops} ${r.reach.hops === 1 ? "hop" : "hops"} (${tierText(r.reach.tier, r.reach.note)})`) : r.declared ? ", declared by this change" : "";
    out.push(`${head} is handled by \`${r.handler}\`${reach}${unmounted}`);
  }
  more(Math.min(fw.routes.length, MAX_LINES), fw.routesTotal);
  for (const t of fw.renders.slice(0, MAX_LINES)) {
    out.push(t.file ? `- \`${t.fromName}\` renders ${t.file} (${tierText(t.tier, t.note)})` : `- \`${t.fromName}\` renders ${t.template}, which is not in the repository`);
  }
  for (const t of fw.renderedBy.slice(0, MAX_LINES)) out.push(`- Template ${t.template} is rendered by \`${t.byName}\` (${t.site.file}:${t.site.line})`);
  for (const m of fw.models.slice(0, MAX_LINES)) {
    if (m.migrations.length === 0) out.push(`- Model \`${m.name}\` has no migration in the repository that names it`);
    else out.push(`- Model \`${m.name}\` has migrations: ${m.migrations.map((x) => `${x.file}${x.operation ? ` (${x.operation})` : ""}`).join(", ")}`);
  }
  for (const m of fw.migrations.slice(0, MAX_LINES)) {
    const what = [...m.models, ...(m.models.length === 0 ? m.operations : [])];
    out.push(`- Migration ${m.file} changes ${what.length > 0 ? what.join(", ") : "nothing the graph can name"}`);
  }
  for (const r of fw.roles.slice(0, MAX_LINES)) out.push(`- \`${r.name}\` is a ${r.role.replaceAll("_", " ")}${r.detail ? ` (${r.detail})` : ""}`);
  if (fw.tests.length > 0) {
    out.push("- Tests that reference, call or may request the touched code (static links, not coverage):");
    for (const t of fw.tests.slice(0, MAX_LINES)) out.push(`  - ${t.site.file}:${t.site.line} \`${t.testName}\` ${VERB[t.category] ?? "references"} \`${t.targetName}\`${t.through ? ` through route ${t.through}` : ""} (${tierText(t.tier, t.note)})`);
    if (fw.testsTotal > Math.min(fw.tests.length, MAX_LINES)) out.push(`  - and ${fw.testsTotal - Math.min(fw.tests.length, MAX_LINES)} more`);
  }
  for (const p of fw.plugins) if (p.status === "failed" || p.status === "stopped") out.push(`- The ${p.id} plugin did not finish: ${p.reason ?? p.status}; its routes and links are missing.`);
  const lines = out.length > 0 ? ["", "Framework entries this change reaches:", ...out] : [];
  if (fw.unknown.length > 0) {
    lines.push("", "What the framework plugins could not see in the changed files:");
    for (const u of fw.unknown.slice(0, MAX_LINES)) lines.push(`- ${u.file ? `${u.file}${u.line ? `:${u.line}` : ""}` : "the repository"}: ${u.note} (${u.cause})`);
    if (fw.unknownTotal > MAX_LINES) lines.push(`- and ${fw.unknownTotal - MAX_LINES} more`);
  }
  return lines;
}
