// The library entry of the openqodex package: what a program gets from
// `import { ... } from "openqodex"`. The command is dist/bin.js; this file
// builds to dist/lib.js beside it, so the lenses, the toolchain table, the
// lock files and the grammars are found in the installed package exactly as
// the command finds them.
//
// Importing this file runs nothing: no command starts, nothing is printed,
// no environment variable is written, no signal handler is added and no
// update check starts. Every function does its work only when called.
import { createToolResolver, loadToolchain, runScanners, toolchainHash } from "@openqodex/scanners";
import { buildGraph, detectImpact, extractFacts, PacketCollision, PacketLeak, writePacket } from "@openqodex/graph";
import {
  defaultLensDir,
  loadConfig,
  loadLensCatalog,
  parseConfig,
  renderJson,
  renderMarkdown,
  renderReview,
  renderSarif,
  selectLenses,
  selectLensesForDiff,
} from "@openqodex/core";

export {
  // scanners
  runScanners,
  createToolResolver,
  loadToolchain,
  toolchainHash,
  // the code graph
  buildGraph,
  detectImpact,
  extractFacts,
  writePacket,
  PacketCollision,
  PacketLeak,
  // the lenses
  loadLensCatalog,
  selectLenses,
  selectLensesForDiff,
  defaultLensDir,
  // the config parser
  parseConfig,
  loadConfig,
  // the renderers
  renderMarkdown,
  renderSarif,
  renderJson,
  renderReview,
};

// The same functions grouped by what they belong to.
export const scanners = { runScanners, createToolResolver, loadToolchain, toolchainHash };
export const graph = { buildGraph, detectImpact, extractFacts, writePacket, PacketCollision, PacketLeak };
export const lenses = { loadLensCatalog, selectLenses, selectLensesForDiff, defaultLensDir };
export const render = { renderMarkdown, renderSarif, renderJson, renderReview };

export type {
  // the finding, report and completion types
  Report,
  ReportFinding,
  Verdict,
  CompletionRecord,
  ModelCompletionRecord,
  AnyCompletionRecord,
  ModelToolEntry,
  ModelAttempt,
  ModelCallUsage,
  ReviewerRecord,
  StaticFinding,
  Candidate,
  Severity,
  Category,
  // what the scanners take and return
  ScannerSource,
  ScannerRunSummary,
  ScanResult,
  ResolveTool,
  ToolResolution,
  DiffCoverage,
  Change,
  ChangedFile,
  // the config
  Config,
  LoadedConfig,
  ParseOptions,
  // the lenses
  Lens,
  SelectedLens,
  // the graph's view of a change
  ImpactSummary,
} from "@openqodex/core";
export type { RunScannersResult, Recipe, Toolchain } from "@openqodex/scanners";
export type { BuildArgs, FileFacts, Graph, Lang } from "@openqodex/graph";
