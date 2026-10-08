// The brief's "What this change reaches" block, rendered from the same
// ImpactSummary the report carries (PLAN.md 3.4): coverage first, then the
// symbols the change touched, removed or moved with the public names it
// removed or bound elsewhere, then the callers by tier with their evidence,
// then what the graph could not see near the change, then how to read it.
// Every cut names the packet file that holds the rest; the packet lies
// inside the folder the reviewer reads, so following the brief never reads
// outside it.
import type { ImpactEdge, ImpactSite, ImpactSummary, ImpactSymbol } from "@openqodex/core";
import { INLINE_SITES } from "./impact.js";

const MAX_TOUCHED = 25;
const MAX_IMPORTERS = 12;
const MAX_CALLEES = 12;
const MAX_EXPORTS = 12;
const MAX_CONSUMERS = 8;
const MAX_NEAR = 12;
const MAX_FLOOR_SEEDS = 8;

function n(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// The key a symbol's packet files are named by.
export function symbolKey(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  const name = id.slice(id.indexOf("#") + 1, id.lastIndexOf("@")).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
  return `${name || "file"}-${h.toString(16).padStart(8, "0")}`;
}

const instruction = (packet: string | null) =>
  [
    "How to read this block. A change in behaviour to a touched symbol (its signature, return shape, errors, side effects or ordering) can break a caller outside the diff. Open the call sites that matter for this change and read them. Raise a finding only when a caller actually breaks, and anchor it on the changed line that breaks it.",
    "\"certain\" means an import, a definition in the same scope or a known receiver type proves the call, and every step it rests on is proved. \"likely\" means a stated convention picked the one target; its note says which, and it is a lead to check, not a fact. \"possible\" means the call reaches one of several definitions and nothing picks one; each is listed with the same note.",
    "A caller list marked as a floor may be short: the graph could not bind some calls (a value of unknown type, a callback, a computed member), or did not read some files. Zero callers on a floor never means unused.",
    packet !== null
      ? `Everything this block leaves out is in \`${packet}\`, inside the folder you read: \`index.md\` lists the files, \`callers/<key>.json\` holds every caller of a symbol, \`unknowns.json\` what the graph could not see. Reading them does not count as reading the changed lines.`
      : "",
  ]
    .filter((l) => l !== "")
    .join(" ");

function siteTier(site: ImpactSite): string {
  if (site.tier === "certain") return "certain";
  return site.note ? `${site.tier}: ${site.note}` : site.tier;
}

// `overflow`: where the rest is when there is no packet (the agent-led
// review keeps impact.json beside its brief, in a folder that agent reads).
export function renderImpactBlock(impact: ImpactSummary, opts: { overflow?: string } = {}): string {
  const out = ["## What this change reaches", ""];
  if (impact.status === "off" || impact.status === "skipped" || impact.status === "failed") {
    const why = impact.reasons.join("; ") || impact.status;
    const lead = impact.status === "off" ? "The code graph is off" : impact.status === "skipped" ? "The code graph was skipped" : "The code graph could not be built";
    out.push(`${lead}: ${why}. Find the callers of changed code with your own tools.`);
    return out.join("\n");
  }
  const b = impact.build;
  const packet = impact.packet;
  const at = (rel: string, lead = ", in") => (packet ? `${lead} \`${packet}${rel}\`` : opts.overflow ? `, listed in ${opts.overflow}` : "");

  // 1. Coverage.
  const counted = b.unresolvedSites === null ? "" : `; ${n(b.unresolvedSites, "call site")} in the repository could not be bound`;
  out.push(`Built on this machine from ${n(b.parsedFiles, "file")} of ${n(b.eligibleFiles, "eligible file")} in ${seconds(b.durationMs)}${b.mode ? `, ${b.mode === "fresh" ? "fresh from cached facts" : "from the retained index"}` : ""}${counted}.`);
  if (impact.status === "partial") {
    out.push(`The graph is partial: ${impact.reasons.join("; ")}. Callers in the files left out are missing, so check the ones that matter with your own tools.`);
  }

  const sym = new Map<string, ImpactSymbol>(impact.symbols.map((s) => [s.id, s]));
  const name = (id: string) => sym.get(id)?.name ?? id;
  const where = (s: ImpactSymbol) => `${s.file}:${s.startLine}`;
  const moved = impact.removed.filter((id) => sym.get(id)?.movedTo);
  const removed = impact.removed.filter((id) => !sym.get(id)?.movedTo);

  if (impact.touched.length === 0 && impact.removed.length === 0 && impact.exports.length === 0) {
    out.push("", "The change touches no function, method, class or type in a TypeScript, JavaScript, Python, Go or Ruby file, so there is no caller to trace.");
    pushImporters(out, impact, at);
    return out.join("\n");
  }

  out.push("", instruction(packet));
  const callerIds = new Set(impact.callers.map((p) => (p.edges[p.edges.length - 1] as ImpactEdge).from));
  const callerFiles = new Set(impact.callers.flatMap((p) => (p.edges[p.edges.length - 1] as ImpactEdge).sites.map((s) => s.file)));
  const parts = [n(impact.touched.length, "symbol") + " touched"];
  if (removed.length > 0) parts.push(`${removed.length} removed`);
  if (moved.length > 0) parts.push(`${moved.length} moved`);
  if (impact.exports.length > 0) parts.push(`${n(impact.exports.length, "public name")} changed`);
  parts.push(`${n(callerIds.size, "caller")} in ${n(callerFiles.size, "file")}${impact.unknown.floor ? ", a floor" : ""}`);
  out.push("", `Risk: ${impact.risk ?? "none"} (${parts.join(", ")})`);

  // 3. Touched, removed and moved symbols, and the export surface diff.
  if (impact.touched.length > 0) {
    out.push("", "Touched symbols:");
    for (const id of impact.touched.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (s) out.push(`- ${where(s)} \`${s.name}\` (${s.kind})`);
    }
    if (impact.touched.length > MAX_TOUCHED) out.push(`- and ${impact.touched.length - MAX_TOUCHED} more`);
  }
  if (removed.length > 0) {
    const called = new Map<string, number>();
    for (const p of impact.callers) {
      const first = p.edges[0] as ImpactEdge;
      if (p.edges.length === 1 && removed.includes(p.seed)) called.set(p.seed, (called.get(p.seed) ?? 0) + first.sites.length);
    }
    // A hub's list was cut to its nearest callers; its count was taken before the cut.
    for (const h of impact.hubs) if (removed.includes(h.symbol)) called.set(h.symbol, h.sites);
    out.push("", "Removed by this change (from the base version):");
    for (const id of removed.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (!s) continue;
      const c = called.get(id) ?? 0;
      out.push(`- ${where(s)} \`${s.name}\` (${s.kind})${c > 0 ? `, still called from ${n(c, "site")}` : ""}`);
    }
    if (removed.length > MAX_TOUCHED) out.push(`- and ${removed.length - MAX_TOUCHED} more`);
  }
  if (moved.length > 0) {
    out.push("", "Moved to another file by this change:");
    for (const id of moved.slice(0, MAX_TOUCHED)) {
      const s = sym.get(id);
      if (!s?.movedTo) continue;
      const to = s.movedTo.renamed ? `moved and renamed to \`${name(s.movedTo.id)}\` at ${s.movedTo.file}:${s.movedTo.line} (the same body)` : `moved to ${s.movedTo.file}:${s.movedTo.line}`;
      out.push(`- ${where(s)} \`${s.name}\` (${s.kind}), ${to}`);
    }
    if (moved.length > MAX_TOUCHED) out.push(`- and ${moved.length - MAX_TOUCHED} more`);
  }
  if (impact.exports.length > 0) {
    out.push("", "Public names this change removed or bound to another definition (compared in the base and the changed version):");
    for (const e of impact.exports.slice(0, MAX_EXPORTS)) {
      const what = e.change === "removed" ? "no longer exported" : `now bound to ${e.after ? `\`${name(e.after.id)}\` at ${e.after.file}:${e.after.line}` : "another definition"}`;
      const was = e.before ? `, was ${e.before.file}:${e.before.line}` : "";
      const users = e.consumersTotal === 0 ? "no consumer in the repository used it" : `${n(e.consumersTotal, "site")} used it`;
      out.push(`- \`${e.name}\` in ${e.file}${e.line ? `:${e.line}` : ""}: ${what}${was}; ${users}`);
      for (const c of e.consumers.slice(0, MAX_CONSUMERS)) {
        const now = c.now === "broken" ? "binds nothing now" : c.now === "retargeted" ? "binds another definition now" : c.now === "unchanged" ? "binds the same definition now" : "its file changed too";
        out.push(`  - ${c.file}:${c.line} in \`${name(c.from)}\`, ${now}`);
      }
      if (e.consumers.length > MAX_CONSUMERS || e.consumersTotal > e.consumers.length) out.push(`  - and ${e.consumersTotal - Math.min(e.consumers.length, MAX_CONSUMERS)} more${at("changes.json")}`);
    }
    if (impact.exports.length > MAX_EXPORTS) out.push(`- and ${impact.exports.length - MAX_EXPORTS} more${at("changes.json")}`);
  }

  // 4. Callers by tier: certain first, then likely with their notes.
  if (impact.callers.length > 0) {
    out.push("", "Call sites of the touched and removed code, certain first:");
    const rows: { tier: number; text: string }[] = [];
    for (const p of impact.callers) {
      const last = p.edges[p.edges.length - 1] as ImpactEdge;
      const via = p.edges.length === 2 ? `, which calls \`${name(p.seed)}\` (2 hops` : " (1 hop";
      const verb = last.kind === "inherits" ? "extends" : "calls";
      for (const site of last.sites) {
        rows.push({ tier: site.tier === "certain" ? 0 : site.tier === "likely" ? 1 : 2, text: `- ${site.file}:${site.line} in \`${name(last.from)}\` ${verb} \`${name(last.to)}\`${via}, ${siteTier(site)})` });
      }
    }
    rows.sort((a, b) => a.tier - b.tier);
    for (const r of rows.slice(0, INLINE_SITES)) out.push(r.text);
    if (rows.length > INLINE_SITES) out.push(`- and ${n(rows.length - INLINE_SITES, "more call site")}${at("callers/", ", every one in")}`);
  } else {
    out.push("", impact.unknown.floor ? "No certain or likely caller of the touched code was found in the graph; the list is a floor (below), so callers may exist." : "No caller of the touched code was found in the graph.");
  }
  for (const h of impact.hubs) {
    out.push(`- \`${name(h.symbol)}\` is a hub: called by ${n(h.callers, "symbol")} from ${n(h.sites, "site")} in ${n(h.files, "file")}; the 20 nearest callers are listed${at(`callers/${symbolKey(h.symbol)}.json`, ", the rest in")}.`);
  }
  for (const c of impact.cuts) {
    if (c.by === "second-hop") out.push(`- The second hop left out ${n(c.omitted ?? 0, "caller")} of \`${name(c.at ?? "")}\`${at(`second-hop/${symbolKey(c.at ?? "")}.json`, "; every one is in")}.`);
    if (c.by === "walk-limit") out.push(`- ${c.note}.`);
  }

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
  pushImporters(out, impact, at);

  // 9. What the graph could not see near the change.
  const floors = impact.unknown.seeds.filter((s) => s.floor);
  const near = impact.unknown.near;
  if (floors.length > 0 || near.length > 0 || impact.unknown.notReadTotal > 0) {
    out.push("", "What the graph could not see:");
    for (const s of floors.slice(0, MAX_FLOOR_SEEDS)) out.push(`- The callers of \`${name(s.seed)}\` are a floor: ${s.reasons.join("; ")}.`);
    if (floors.length > MAX_FLOOR_SEEDS) out.push(`- and ${floors.length - MAX_FLOOR_SEEDS} more symbols with a floor`);
    const byCause = Object.entries(impact.unknown.causes)
      .filter(([, v]) => v !== null && v > 0)
      .map(([k, v]) => `${v} ${k}`);
    if (byCause.length > 0) out.push(`- In the changed files and their callers' files, ${n(impact.unknown.nearTotal, "call site")} could not be bound (${byCause.join(", ")}):`);
    for (const u of near.slice(0, MAX_NEAR)) {
      const at = u.file && u.line ? `${u.file}:${u.line}` : (u.file ?? "the repository");
      out.push(`  - ${at}${u.name ? ` \`${u.name}\`` : ""}: ${u.cause}${u.note ? `, ${u.note}` : ""}`);
    }
    if (impact.unknown.nearTotal > MAX_NEAR) out.push(`  - and ${impact.unknown.nearTotal - MAX_NEAR} more${at("unknowns.json")}`);
    if (impact.unknown.notReadTotal > 0) {
      const sample = impact.unknown.notRead.slice(0, 5).map((f) => `${f.file} (${f.reason})`);
      out.push(`- ${n(impact.unknown.notReadTotal, "eligible file")} ${impact.unknown.notReadTotal === 1 ? "was" : "were"} not read: ${sample.join(", ")}${impact.unknown.notReadTotal > sample.length ? ", ..." : ""}`);
    }
  }
  return out.join("\n");
}

function pushImporters(out: string[], impact: ImpactSummary, at: (rel: string) => string): void {
  if (impact.importers.length === 0) return;
  out.push("", "Files that import a changed file:");
  for (const e of impact.importers.slice(0, MAX_IMPORTERS)) {
    const site = e.sites[0];
    out.push(`- ${site ? `${site.file}:${site.line}` : e.from} imports ${e.to.replace(/^go:/, "package ")}${site && site.tier !== "certain" ? ` (${siteTier(site)})` : ""}`);
  }
  if (impact.importers.length > MAX_IMPORTERS) out.push(`- and ${impact.importers.length - MAX_IMPORTERS} more${at("importers/")}`);
}
