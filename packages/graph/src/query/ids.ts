// Edge ids: opaque, so no part of a path or a name can be read as a
// separator, and read back with one JSON.parse, never a pattern.
import type { GraphSite } from "../types.js";

export function edgeId(e: { from: string; to: string; kind: string }, site: Pick<GraphSite, "file" | "line" | "column">): string {
  return `e.${Buffer.from(JSON.stringify([e.kind, e.from, e.to, site.file, site.line, site.column])).toString("base64url")}`;
}

const MAX_EDGE_ID = 64 * 1024;

export function readEdgeId(id: string): { kind: string; from: string; to: string; file: string; line: number; column: number } | null {
  if (!id.startsWith("e.") || id.length > MAX_EDGE_ID) return null;
  try {
    const v = JSON.parse(Buffer.from(id.slice(2), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 6) return null;
    const [kind, from, to, file, line, column] = v as unknown[];
    if (typeof kind !== "string" || typeof from !== "string" || typeof to !== "string" || typeof file !== "string" || !Number.isInteger(line) || !Number.isInteger(column)) return null;
    return { kind, from, to, file, line: line as number, column: column as number };
  } catch {
    return null;
  }
}
