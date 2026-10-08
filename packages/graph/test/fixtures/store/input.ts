// What the store tests publish and cache: a publish input with the shape
// the build gives it, facts that pass the facts schema, and facts keys.
import { createHash } from "node:crypto";
import type { PublishInput } from "../../../src/store/types.js";
import type { FileFacts } from "../../../src/types.js";

export function keyOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

// Facts of a file with `defs` definitions; names are padded so `defs`
// sets the size (about 200 bytes each).
export function factsOf(name: string, defs = 1): FileFacts {
  return {
    lang: "typescript",
    defs: Array.from({ length: defs }, (_, i) => ({
      name: `${name}_${i}_${"x".repeat(80)}`,
      kind: "function" as const,
      owner: null,
      line: i + 1,
      column: 0,
      endLine: i + 2,
      exported: true,
      topLevel: true,
      bases: [],
      fields: {},
    })),
    calls: [],
    values: [],
    types: [],
    tables: [],
    imports: [],
    exportsLocal: [],
    defaultExport: null,
    goPackage: null,
  };
}

export type InputOptions = {
  tag?: string;
  complete?: boolean;
  tree?: string | null;
  // Facts keys the inventory names, one per file a.ts, b.ts, ...
  keys?: string[];
  // Extra generation files by path.
  files?: Record<string, string>;
};

export function publishInput(opts: InputOptions = {}): PublishInput {
  const tag = opts.tag ?? "t";
  const complete = opts.complete ?? true;
  const inventory = { files: Object.fromEntries((opts.keys ?? []).map((key, i) => [`src/f${i}.ts`, { key, lang: "typescript", bytes: 10 }])) };
  return {
    manifest: {
      capture: { kind: "working-tree", treeSha: opts.tree ?? null, digest: `digest-${tag}`, dirtyPaths: [] },
      versions: { model: 1, extractor: 1, resolver: 1, policy: 1 },
      config: { budgetMs: 10_000, maxFiles: 4000, maxFileBytes: 524_288, maxHeapMb: 1024 },
      status: complete ? "ok" : "partial",
      complete,
      counts: { eligible: 5, inGraph: complete ? 5 : 2, parsed: 2, fromCache: 0, skipped: complete ? 0 : 3 },
      mode: "fresh",
      reasons: complete ? [] : ["budget"],
      stages: { capture: 1, extract: 2 },
      wallMs: 3,
      hasIndex: false,
    },
    files: {
      "inventory.json": JSON.stringify(inventory),
      "projects.json": JSON.stringify({ tag, projects: [] }),
      "coverage.json": JSON.stringify({ tag, notParsed: [] }),
      ...opts.files,
    },
  };
}
