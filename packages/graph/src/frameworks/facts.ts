// Runs every registered plugin's context-free fact reader on one parsed
// file. Called once per parse, beside the language extractor; the result
// is cached with the language facts under the file's content.
import type { Node } from "web-tree-sitter";
import type { Lang } from "../types.js";
import { MAX_FACTS_PER_FILE } from "./plugin.js";

import type { FrameworkFactBase, FrameworkFileFacts, FrameworkPlugin } from "./plugin.js";
import { PLUGINS } from "./registry.js";

// The largest source a plugin reads. A larger file keeps no plugin facts and
// is reported as not read by the plugins, whatever the build's own size cap.
export const MAX_PLUGIN_SOURCE_BYTES = 1024 * 1024;

export function frameworkFacts(root: Node, lang: Lang, source: string, plugins: readonly FrameworkPlugin[] = PLUGINS): FrameworkFileFacts | undefined {
  let out: FrameworkFileFacts | undefined;
  const tooBig = Buffer.byteLength(source, "utf8") > MAX_PLUGIN_SOURCE_BYTES;
  for (const p of plugins) {
    if (!p.languages.includes(lang)) continue;
    let list: FrameworkFactBase[];
    if (tooBig) {
      (out ??= {})[p.id] = [{ kind: "error", line: 1, column: 0, note: `over the ${MAX_PLUGIN_SOURCE_BYTES} bytes a framework plugin reads` } as FrameworkFactBase];
      continue;
    }
    try {
      if (!p.wants(source, lang)) continue;
      list = p.facts(root, lang);
    } catch (error) {
      // The file keeps no facts of this plugin; the stage reports it as not read.
      list = [{ kind: "error", line: 1, column: 0, note: String((error as Error)?.message ?? error).slice(0, 200) } as FrameworkFactBase];
    }
    if (list.length > MAX_FACTS_PER_FILE) {
      const omitted = list.length - MAX_FACTS_PER_FILE;
      list = [...list.slice(0, MAX_FACTS_PER_FILE), { kind: "overflow", line: 1, column: 0, omitted } as FrameworkFactBase];
    }
    if (list.length > 0) (out ??= {})[p.id] = list;
  }
  return out;
}

// The shape check for the cached envelope: plugin ids, lists of objects with
// a kind and a position. Each plugin checks its own facts' fields.
export function isFrameworkFileFacts(v: unknown): v is FrameworkFileFacts {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 64) return false;
  for (const [id, list] of entries) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || !Array.isArray(list) || list.length > MAX_FACTS_PER_FILE + 1) return false;
    for (const f of list as unknown[]) {
      if (typeof f !== "object" || f === null) return false;
      const r = f as Record<string, unknown>;
      if (typeof r.kind !== "string" || !Number.isInteger(r.line) || !Number.isInteger(r.column)) return false;
    }
  }
  return true;
}
