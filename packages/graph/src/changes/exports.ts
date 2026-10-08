// The export-surface diff, in two worlds (PLAN.md 3.4). The base world is
// the graph with the base version of every changed file (and the base
// project model when a manifest changed); the current world is the graph
// of the change. A public name is compared by what it binds in each world,
// never by comparing definitions, so removing `export { target as
// publicApi }` while `target` stays is a removed name, and a barrel that
// binds `api` to another definition is a retarget.
//
// Consumers come from the base world: every call site and import binding
// whose resolution read the changed name, found by tracing the affected
// closure (the changed files, the files that import them, and through
// every re-export, the files that import those, with no hop bound). The
// same site in the current world says what the consumer binds now.
import type { ImpactExportChange } from "@openqodex/core";
import type { SiteTrace, World } from "../resolve.js";

const MAX_CONSUMERS_KEPT = 200;

export type ChangedFile = { path: string; oldPath: string | null; status: "added" | "modified" | "deleted" | "renamed" };

export function exportChanges(args: {
  current: World;
  base: World;
  changed: ChangedFile[];
  files: string[]; // every file of the current world
  baseFiles: string[]; // every file of the base world
  removedKeys: ReadonlySet<string>; // stable keys of definitions the change removed outright
  // Files whose bindings a changed manifest or tsconfig decides, with the
  // manifest: their import sites are compared between the worlds too.
  seeds: { manifest: string; files: string[] }[];
  // The node of a stable key or id in each world, for `before` and `after`.
  nodeOf: (world: "base" | "current", id: string) => { id: string; file: string; line: number } | null;
}): ImpactExportChange[] {
  const changedPaths = new Set(args.changed.flatMap((c) => [c.path, ...(c.oldPath ? [c.oldPath] : [])]));

  // The affected closure: importers of a file in it join it; an importer
  // that re-exports from it carries the closure on.
  const reverse = (world: World, files: string[]) => {
    const rev = new Map<string, { from: string; reexport: boolean }[]>();
    for (const f of files) {
      for (const t of world.importsOf(f)) {
        const list = rev.get(t.target);
        if (list) list.push({ from: f, reexport: t.reexport });
        else rev.set(t.target, [{ from: f, reexport: t.reexport }]);
      }
    }
    return rev;
  };
  const closure = new Set<string>(changedPaths);
  const carry = [...changedPaths];
  for (const rev of [reverse(args.current, args.files), reverse(args.base, args.baseFiles)]) {
    const queue = [...carry];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const at = queue.pop() as string;
      for (const r of rev.get(at) ?? []) {
        closure.add(r.from);
        // Python modules re-export every name they import, so any Python importer carries it on.
        if ((r.reexport || r.from.endsWith(".py")) && !seen.has(r.from)) {
          seen.add(r.from);
          queue.push(r.from);
        }
      }
    }
  }
  for (const s of args.seeds) for (const f of s.files) closure.add(f);

  const baseTraces = args.base.trace(closure);
  const currentTraces = args.current.trace(closure);
  const siteKey = (t: Pick<SiteTrace, "file" | "line" | "column">) => `${t.file}:${t.line}:${t.column}`;
  const now = new Map<string, string[] | null>();
  for (const t of currentTraces) if (!now.has(siteKey(t)) || t.targets !== null) now.set(siteKey(t), t.targets);
  const same = (a: string[] | null, b: string[] | null) => a !== null && b !== null && a.join("\0") === b.join("\0");
  const statusOf = (t: SiteTrace): "broken" | "retargeted" | "unchanged" | "unknown" => {
    if (changedPaths.has(t.file)) return "unknown";
    const cur = now.get(siteKey(t));
    if (cur === undefined || cur === null) return "broken";
    return same(cur, t.targets) ? "unchanged" : "retargeted";
  };

  const out: ImpactExportChange[] = [];
  for (const c of args.changed) {
    if (c.status === "added") continue;
    const baseFile = c.oldPath ?? c.path;
    const before = args.base.surface(baseFile);
    const after = c.status === "deleted" ? new Map() : args.current.surface(c.path);
    // A renamed file's definitions keep their keys under the new path.
    const moveKey = (k: string) => (c.oldPath && k.startsWith(`${c.oldPath}#`) ? `${c.path}#${k.slice(c.oldPath.length + 1)}` : k);
    for (const [name, b] of before) {
      if (b.target === null || b.target === "ext") continue;
      // A definition the change deleted or moved is reported with the removed symbols.
      if (b.target.keys.every((k) => args.removedKeys.has(k))) continue;
      const a = after.get(name);
      const baseKeys = b.target.keys.map(moveKey);
      let change: "removed" | "retargeted" | null = null;
      if (a === undefined || a.target === null) change = "removed"; else if (a.target !== "ext" && a.target.keys.join("\0") !== baseKeys.join("\0")) change = "retargeted";
      if (change === null) continue;
      const read = `${baseFile}\0${name}`;
      const consumers = dedupe(baseTraces.filter((t) => t.reads.includes(read) && t.file !== baseFile && t.file !== c.path));
      out.push({
        file: c.path,
        name,
        change,
        line: b.line,
        before: args.nodeOf("base", b.target.ids[0] as string),
        after: a?.target && a.target !== "ext" ? args.nodeOf("current", a.target.ids[0] as string) : null,
        consumers: consumers.slice(0, MAX_CONSUMERS_KEPT).map((t) => ({ file: t.file, line: t.line, column: t.column, from: t.from, now: statusOf(t) })),
        consumersTotal: consumers.length,
      });
    }
  }

  // Sites a changed manifest or tsconfig decides: an import that bound one
  // definition in the base world and binds nothing or another one now.
  const baseBySite = new Map<string, SiteTrace>();
  for (const t of baseTraces) if (t.targets !== null) baseBySite.set(siteKey(t), t);
  for (const s of args.seeds) {
    const files = new Set(s.files);
    const groups = new Map<string, SiteTrace[]>();
    for (const t of baseBySite.values()) {
      if (!files.has(t.file) || changedPaths.has(t.file)) continue;
      const status = statusOf(t);
      if (status === "unchanged" || status === "unknown") continue;
      const first = t.targets?.[0] ?? "";
      const name = first.slice(first.indexOf("#") + 1);
      const list = groups.get(name);
      if (list) list.push(t);
      else groups.set(name, [t]);
    }
    for (const [name, sites] of groups) {
      const consumers = dedupe(sites);
      const anyBroken = consumers.some((t) => statusOf(t) === "broken");
      out.push({
        file: s.manifest,
        name,
        change: anyBroken ? "removed" : "retargeted",
        line: null,
        before: args.nodeOf("base", (consumers[0]?.targets?.[0] ?? "") as string),
        after: null,
        consumers: consumers.slice(0, MAX_CONSUMERS_KEPT).map((t) => ({ file: t.file, line: t.line, column: t.column, from: t.from, now: statusOf(t) })),
        consumersTotal: consumers.length,
      });
    }
  }
  return out;
}

function dedupe(traces: SiteTrace[]): SiteTrace[] {
  const seen = new Set<string>();
  const out: SiteTrace[] = [];
  for (const t of traces) {
    const k = `${t.file}:${t.line}:${t.column}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

