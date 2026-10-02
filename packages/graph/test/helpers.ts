import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Graph } from "../src/index.js";

// A real git repo in a temp folder holding `files`.
export function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oq-graph-"));
  writeFiles(root, files);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  return root;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function commitAll(root: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return git(root, "rev-parse", "HEAD").trim();
}

// "path:line" of the line holding `marker` in a fixture file.
export function at(files: Record<string, string>, path: string, marker: string): string {
  const lines = (files[path] as string).split("\n");
  const i = lines.findIndex((l) => l.includes(marker));
  if (i === -1) throw new Error(`${marker} not in ${path}`);
  return `${path}:${i + 1}`;
}

// The id of the one symbol `name` in `file`: with no owner, or with `owner`.
export function symbol(graph: Graph, file: string, name: string, owner?: string): string {
  const prefix = owner === undefined ? `#${name}@` : `#${owner}.${name}@`;
  const hits = (graph.defsByFile.get(file) ?? []).filter((n) => n.name === name && n.id.includes(prefix));
  if (hits.length !== 1) throw new Error(`${hits.length} symbols named ${name} in ${file}`);
  return (hits[0] as { id: string }).id;
}

// Every call site, as "path:line", of edges into `id`.
export function callSites(graph: Graph, id: string, kind: "calls" | "inherits" = "calls"): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === kind)
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line}`))
    .sort();
}
