// The brief's "Blast radius" block, rendered from the same ImpactSummary the
// report carries.
import type { ImpactEdge, ImpactSummary, ImpactSymbol } from "@openqodex/core";
import { INLINE_SITES } from "./impact.js";

const MAX_TOUCHED = 25;
const MAX_IMPORTERS = 12;
const MAX_CALLEES = 12;

function n(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

const INSTRUCTION =
  "A change in behaviour to a touched symbol (its signature, return shape, errors, side effects or ordering) can break a caller outside the diff. Open the call sites below that matter for this change and read them. Raise a finding only when a caller actually breaks, and anchor it on the changed line that breaks it. \"certain\" means an import, a definition in the same scope or a known receiver type proves the call; \"likely\" calls are leads to check, not facts. The graph cannot see dynamic calls (callbacks, reflection, receivers of unknown type), so a symbol with no listed callers may still be called.";

export function renderImpactBlock(impact: ImpactSummary): string {
  const out = ["## Blast radius", ""];
  if (impact.status === "off" || impact.status === "skipped" || impact.status === "failed") {
    const why = impact.reasons.join("; ") || impact.status;
    const lead = impact.status === "off" ? "The code graph is off" : impact.status === "skipped" ? "The code graph was skipped" : "The code graph could not be built";
    out.push(`${lead}: ${why}. Find the callers of changed code with your own tools.`);
    return out.join("\n");
  }
  const b = impact.build;
  if (impact.status === "partial") {
    out.push(
      `The graph is partial: ${impact.reasons.join("; ")}. ${n(b.parsedFiles, "file")} of ${n(b.eligibleFiles, "file")} are in it; callers in the others are missing, so check the ones that matter with your own tools.`,
      "",
    );
  }
  out.push(
    `Built on this machine from the call graph of ${n(b.parsedFiles, "file")} in ${seconds(b.durationMs)}; ${n(b.unresolvedSites, "call site")} could not be bound to a definition and are not counted.`,
  );

  const sym = new Map<string, ImpactSymbol>(impact.symbols.map((s) => [s.id, s]));
  const name = (id: string) => sym.get(id)?.name ?? id;
  const where = (s: ImpactSymbol) => `${s.file}:${s.startLine}`;

  if (impact.touched.length === 0 && impact.removed.length === 0) {
    out.push("", "The change touches no function, method, class or type in a TypeScript, JavaScript, Python, Go or Ruby file, so there is no caller to trace.");
    pushImporters(out, impact);
    return out.join("\n");
  }

  out.push("", INSTRUCTION);
  const callerIds = new Set(impact.callers.map((p) => (p.edges[p.edges.length - 1] as ImpactEdge).from));
  const callerFiles = new Set(impact.callers.flatMap((p) => (p.edges[p.edges.length - 1] as ImpactEdge).sites.map((s) => s.file)));
  const parts = [n(impact.touched.length, "symbol") + " touched"];
  if (impact.removed.length > 0) parts.push(`${impact.removed.length} removed`);
  parts.push(`${n(callerIds.size, "caller")} in ${n(callerFiles.size, "file")}`);
  out.push("", `Risk: ${impact.risk ?? "none"} (${parts.join(", ")})`);

  if (impact.touched.length > 0) {
    out.push("", "Touched symbols:");
    for (const id of impact.touched.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (s) out.push(`- ${where(s)} \`${s.name}\` (${s.kind})`);
    }
    if (impact.touched.length > MAX_TOUCHED) out.push(`- and ${impact.touched.length - MAX_TOUCHED} more`);
  }
  if (impact.removed.length > 0) {
    const called = new Map<string, number>();
    for (const p of impact.callers) {
      const first = p.edges[0] as ImpactEdge;
      if (p.edges.length === 1 && impact.removed.includes(p.seed)) called.set(p.seed, (called.get(p.seed) ?? 0) + first.sites.length);
    }
    out.push("", "Removed by this change (from the base version):");
    for (const id of impact.removed.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (!s) continue;
      const c = called.get(id) ?? 0;
      out.push(`- ${where(s)} \`${s.name}\` (${s.kind})${c > 0 ? `, still called from ${n(c, "site")}` : ""}`);
    }
    if (impact.removed.length > MAX_TOUCHED) out.push(`- and ${impact.removed.length - MAX_TOUCHED} more`);
  }

  if (impact.callers.length > 0) {
    out.push("", "Call sites of the touched and removed code:");
    let shown = 0;
    let total = 0;
    for (const p of impact.callers) {
      const last = p.edges[p.edges.length - 1] as ImpactEdge;
      const via = p.edges.length === 2 ? `, which calls \`${name(p.seed)}\` (2 hops` : " (1 hop";
      const verb = last.kind === "inherits" ? "extends" : "calls";
      for (const site of last.sites) {
        total++;
        if (shown >= INLINE_SITES) continue;
        shown++;
        const confidence = site.confidence === "high" ? "certain" : "likely";
        out.push(`- ${site.file}:${site.line} in \`${name(last.from)}\` ${verb} \`${name(last.to)}\`${via}, ${confidence})`);
      }
    }
    if (total > shown) out.push(`- and ${n(total - shown, "more call site")}, listed in impact.json beside this brief`);
  } else {
    out.push("", "No caller of the touched code was found in the graph.");
  }
  for (const h of impact.hubs) {
    out.push(`- \`${name(h.symbol)}\` is a hub: called by ${n(h.callers, "symbol")} from ${n(h.sites, "site")} in ${n(h.files, "file")}; the 20 nearest callers are listed.`);
  }
  if (impact.truncated.walk && impact.hubs.length === 0) out.push("- The walk stopped at 200 symbols; callers further out are not listed.");

  if (impact.callees.length > 0) {
    out.push("", "Called by the touched code:");
    const seen = new Set<string>();
    for (const p of impact.callees) {
      const e = p.edges[0] as ImpactEdge;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      if (seen.size > MAX_CALLEES) continue;
      const s = sym.get(e.to);
      if (s) out.push(`- ${where(s)} \`${s.name}\` (${s.kind})`);
    }
    if (seen.size > MAX_CALLEES) out.push(`- and ${seen.size - MAX_CALLEES} more`);
  }
  pushImporters(out, impact);
  return out.join("\n");
}

function pushImporters(out: string[], impact: ImpactSummary): void {
  if (impact.importers.length === 0) return;
  out.push("", "Files that import a changed file:");
  for (const e of impact.importers.slice(0, MAX_IMPORTERS)) {
    const site = e.sites[0];
    out.push(`- ${site ? `${site.file}:${site.line}` : e.from} imports ${e.to.replace(/^go:/, "package ")}`);
  }
  if (impact.importers.length > MAX_IMPORTERS) out.push(`- and ${impact.importers.length - MAX_IMPORTERS} more`);
}
