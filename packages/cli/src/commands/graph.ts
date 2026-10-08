// `openqodex graph <operation>`: the code graph's answers on the command
// line, hidden from the menu in phase 1 (docs/graph.md says the commands
// may change). Every operation goes through the one query function of the
// graph package, the same one the review packet is made with.
//
// Each run captures the work tree (or opens `--generation <id>` and never
// refreshes), builds or reuses the graph in .openqodex/graph/, holds the
// build with a lease while it answers, and prints one fact per line, or the
// Answer as JSON with --json. Exit 0 for any answer, partial or unknown
// included; 2 when the request could not be answered or the build failed.
import { findRepoRoot, getChange, loadConfig, OpenQodexError } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { buildGraph, detectImpact, graphOf, openStore, OPERATIONS, query } from "@openqodex/graph";
import type { Answer, Graph, GraphStore, Item, Lease, Operation, Request, Session } from "@openqodex/graph";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { parseFlags } from "../flags.js";

const USAGE = [
  "usage: openqodex graph <operation> [<target>] [options]",
  "  build [--full]                  build or update .openqodex/graph/ for the work tree",
  "  status | capabilities",
  "  search <text>",
  "  symbol | callers | callees <name | file:line> [--file <path>] [--tier certain,likely] [--depth 1..3]",
  "  importers <file>",
  "  changes [--base <ref>]          public names, removed and moved symbols of the change",
  "  unknowns [--file <path> | --name <name>]",
  "  explain <edge id>",
  "  options: --json, --limit <n>, --cursor <c>, --generation <build id>, --cwd <dir>",
].join("\n");

const BUILD_ALL_MS = 600_000;

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

function parseTarget(value: string | undefined, file: string | undefined): Request["target"] {
  if (value === undefined) return file ? { file } : {};
  const m = /^(.+):(\d+)$/.exec(value);
  if (m) return { file: m[1] as string, line: Number(m[2]) };
  return { name: value, ...(file ? { file } : {}) };
}

// One fact per line: sites as file:line, tiers spelled out.
function printText(a: Answer, op: Operation): void {
  if (a.error) {
    out(`${a.error.code}: ${a.error.message}`);
    if (Array.isArray(a.target)) for (const c of a.target) out(`  candidate ${c.file}:${c.line} ${c.kind} ${c.name} (${c.id})`);
  }
  const t = a.target && !Array.isArray(a.target) ? a.target : null;
  if (t) out(`${t.kind} ${t.name} at ${t.file}:${t.line} (${t.id})`);
  for (const l of a.leads) out(`lead ${l.file}:${l.line} ${l.kind} ${l.name} (${l.id})`);
  for (const raw of a.items) {
    const i = raw as Item & Record<string, unknown>;
    if (i.site && i.edge) {
      const verb = op === "callees" ? `calls ${i.toName ?? i.to}` : i.kind === "imports" ? "imports it" : `in ${i.fromName ?? i.from}`;
      out(`${i.site.file}:${i.site.line} ${verb}, ${i.site.tier}${i.depth > 1 ? `, ${i.depth} hops` : ""}${i.site.note ? `: ${i.site.note}` : ""} [${i.edge}]`);
    } else out(JSON.stringify(raw));
  }
  if (a.counts.certain !== null) out(`counts: ${a.counts.certain} certain, ${a.counts.likely} likely, ${a.counts.possible} possible`);
  if (a.truncated.by) out(`truncated by ${a.truncated.by}: ${a.truncated.omitted ?? "an unknown number of"} more; --cursor ${a.truncated.cursor}`);
  if (a.unknown.floor) out(`floor: ${a.unknown.reasons.join("; ") || "the graph could not see every call"}`);
  const g = a.graph;
  out(`graph: build ${g.generation ?? "not saved"}, ${g.status}, ${g.mode}${g.reasons.length > 0 ? `: ${g.reasons.join("; ")}` : ""}${g.freshness.laterEditsKnown ? "; files changed since this build" : ""}`);
}

export async function run(args: string[]): Promise<number> {
  const { global, bools, values, positionals } = parseFlags(args, {
    bools: ["--json", "--full"],
    values: ["--file", "--name", "--tier", "--depth", "--limit", "--cursor", "--generation", "--base"],
    positionals: 2,
    globals: ["--cwd", "--config", "--quiet"],
  });
  const op = positionals[0];
  if (op === undefined) throw new OpenQodexError(`name an operation\n${USAGE}`);
  if (op !== "build" && !(OPERATIONS as readonly string[]).includes(op)) throw new OpenQodexError(`unknown operation: ${op}\n${USAGE}`);
  const repoRoot = await findRepoRoot(global.cwd);
  const config = loadConfig(repoRoot, global.config).config;
  const opened = await openStore(repoRoot, { maxCacheMb: config.graph.maxCacheMb });
  if (!opened.ok) say(`openqodex: the code graph's folder is not used: ${opened.reason}`);
  const store: GraphStore | null = opened.ok ? opened.store : null;
  const progress = (line: string) => {
    if (!global.quiet) say(line);
  };

  let graph: Graph;
  let lease: Lease | null = null;
  let changes: { exports: Graph["exportChanges"]; removed: ReturnType<typeof detectImpact>["symbols"]; moved: ReturnType<typeof detectImpact>["symbols"] } | undefined;
  const generation = values.get("--generation");
  try {
    if (generation !== undefined) {
      if (!store) throw new OpenQodexError("--generation needs the graph folder, and it is not usable here");
      const held = await store.lease({ id: generation }, "cli");
      if (!held) {
        process.stdout.write(bools.has("--json") ? `${JSON.stringify({ error: { code: "generation-unavailable", message: `no kept build ${generation}` } })}\n` : `generation-unavailable: no kept build ${generation}\n`);
        return EXIT_TOOL_FAILED;
      }
      lease = held.lease;
      const g = graphOf(store, held.generation);
      if (!g) throw new OpenQodexError(`build ${generation} could not be read back`);
      graph = g;
    } else {
      const whole = op === "build";
      if (whole && !store) progress("openqodex: building in memory only; nothing is kept");
      let base: { sha: string; files: Change["files"] } | undefined;
      let change: Change | undefined;
      if (op === "changes") {
        change = await getChange({ repoRoot, scope: values.has("--base") ? { base: values.get("--base") } : {}, exclude: config.exclude, defaultBase: config.defaultBase });
        base = { sha: change.baseSha, files: change.files };
      }
      graph = await buildGraph({
        repoRoot,
        store,
        capture: "working-tree",
        files: change?.changedPaths,
        base,
        budgetMs: whole ? BUILD_ALL_MS : config.graph.budgetMs,
        maxFiles: whole ? Number.MAX_SAFE_INTEGER : config.graph.maxFiles,
        maxFileBytes: config.graph.maxFileBytes,
        maxHeapMb: config.graph.maxHeapMb,
        mode: bools.has("--full") ? "fresh" : undefined,
        onProgress: progress,
      });
      if (change) {
        const impact = detectImpact(graph, change);
        const removed = impact.symbols.filter((s) => impact.removed.includes(s.id));
        // Every consumer of each changed public name: the summary's cap is for the brief only.
        changes = { exports: graph.exportChanges, removed: removed.filter((s) => !s.movedTo), moved: removed.filter((s) => s.movedTo) };
      }
      if (store && graph.status.generation) lease = (await store.lease({ id: graph.status.generation }, "cli"))?.lease ?? null;
    }
    const session: Session = { graph, generation: graph.status.generation, treeSha: null, builtAt: null, laterEditsKnown: false };
    if (store && graph.status.generation) {
      const m = store.open({ id: graph.status.generation })?.manifest;
      session.treeSha = m?.capture.treeSha ?? null;
      session.builtAt = m?.createdAt ?? null;
    }
    if (op === "build") {
      const s = graph.status;
      const a = query(session, { apiVersion: 1, kind: "status" });
      if (bools.has("--json")) out(JSON.stringify(a));
      else {
        out(`Built ${s.filesParsed} of ${s.eligibleFiles} files in ${(s.durationMs / 1000).toFixed(1)} s: ${s.parses} parsed, ${s.cacheHits} from cache, mode ${s.mode} (predicted ${s.predictedMs ?? "?"} ms).`);
        out(`build ${s.generation ?? "not saved"}, ${s.status}${s.reasons.length > 0 ? `: ${s.reasons.join("; ")}` : ""}`);
      }
      return s.generation === null && store !== null ? EXIT_TOOL_FAILED : EXIT_OK;
    }
    const tiers = values.get("--tier")?.split(",").map((t) => t.trim()) as Request["tiers"];
    const target = op === "unknowns" ? { ...(values.has("--file") ? { file: values.get("--file") } : {}), ...(values.has("--name") ? { name: values.get("--name") } : {}) } : op === "explain" ? { id: positionals[1] } : parseTarget(positionals[1], values.get("--file"));
    const request: Request = {
      apiVersion: 1,
      kind: op as Operation,
      target,
      text: op === "search" ? positionals[1] : undefined,
      tiers,
      depth: values.has("--depth") ? Number(values.get("--depth")) : undefined,
      limit: values.has("--limit") ? Number(values.get("--limit")) : undefined,
      cursor: values.get("--cursor"),
    };
    const answer = query(session, request, { changes });
    if (bools.has("--json")) out(JSON.stringify(answer));
    else printText(answer, op as Operation);
    return answer.error === null || answer.error.code === "ambiguous" ? EXIT_OK : EXIT_TOOL_FAILED;
  } finally {
    lease?.release();
  }
}
