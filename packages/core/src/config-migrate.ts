// `openqodex config migrate`: the rewrite of the repo's config that the
// CONFIG_CHANGES table asks for: renamed keys under their new names,
// removed keys taken out, and the 0.1.0 root file moved into .openqodex/.
// It is planned first and written only when asked; comments are kept (the
// YAML document is edited, not regenerated), and a rewrite that would
// change what the config does is refused.
import { isMap, isScalar, parseDocument } from "yaml";
import { CONFIG_CHANGES, CONFIG_MAX_BYTES, configHash, parseConfig, type ConfigChange } from "./config.js";
import { readRepoFile, removeRepoFile, writeRepoFile } from "./repo-state.js";
import { OpenQodexError } from "./types.js";

export type Migration = {
  // The config file read now, from the repository root; null: none.
  file: string | null;
  // Where the rewritten file goes: `file`, or the new place of a moved file.
  target: string | null;
  // One line per change.
  changes: string[];
  // The rewritten text; null when nothing changes.
  text: string | null;
};

export function planMigration(repoRoot: string, changes: readonly ConfigChange[] = CONFIG_CHANGES): Migration {
  const moved = changes.find((c): c is Extract<ConfigChange, { kind: "moved" }> => c.kind === "moved");
  const names = moved === undefined ? [] : [moved.to, moved.file];
  const texts = names.map((name) => ({ name, text: readRepoFile(repoRoot, name, CONFIG_MAX_BYTES) }));
  const found = texts.find((t) => t.text !== null);
  if (found === undefined) return { file: null, target: null, changes: [], text: null };
  const file = found.name;
  const before = found.text!;
  const doc = parseDocument(before);
  if (doc.errors.length > 0) throw new OpenQodexError(`${file}: not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  const lines: string[] = [];
  // A rename changes the key's own text in place, so every byte around it,
  // comments included, stays as written.
  let text = before;
  const top = doc.contents;
  const renames: { start: number; end: number; to: string }[] = [];
  for (const c of changes) {
    if (c.kind !== "renamed" || !isMap(top)) continue;
    const pair = top.items.find((p) => isScalar(p.key) && p.key.value === c.key);
    if (pair === undefined || top.has(c.to) || !isScalar(pair.key) || !pair.key.range) continue;
    renames.push({ start: pair.key.range[0], end: pair.key.range[1], to: c.to });
    lines.push(`${c.key} renamed to ${c.to}`);
  }
  for (const r of renames.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start) + r.to + text.slice(r.end);
  // A removal takes the key out of the document.
  const after = parseDocument(text);
  let removed = false;
  for (const c of changes) {
    if (c.kind !== "removed") continue;
    const path = c.key.split(".");
    if (!after.hasIn(path)) continue;
    after.deleteIn(path);
    removed = true;
    lines.push(`${c.key} removed: ${c.why}`);
  }
  if (removed) text = String(after);
  const target = moved !== undefined && file === moved.file && texts[0]!.text === null ? moved.to : file;
  if (target !== file) lines.push(`${file} moved to ${target}`);
  if (lines.length === 0) return { file, target, changes: [], text: null };
  // What the config does must not change: the same effective config, read
  // from the new place.
  if (configHash(parseConfig(text, target).config) !== configHash(parseConfig(before, file).config)) {
    throw new OpenQodexError(`${file}: the rewrite would change what the config does; nothing was written`);
  }
  return { file, target, changes: lines, text };
}

// Writes what planMigration planned: the new text, and for a moved file the
// new file first, then the old one removed. Nothing when nothing changes.
export function applyMigration(repoRoot: string, m: Migration): void {
  if (m.text === null || m.file === null || m.target === null) return;
  if (m.target === m.file) {
    writeRepoFile(repoRoot, m.file, m.text);
    return;
  }
  if (!writeRepoFile(repoRoot, m.target, m.text, { exclusive: true })) throw new OpenQodexError(`${m.target} is there already; nothing was moved`);
  removeRepoFile(repoRoot, m.file);
}
