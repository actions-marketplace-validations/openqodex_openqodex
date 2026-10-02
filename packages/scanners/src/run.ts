// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { AdapterResult, Config, DiffCoverage, ResolveTool, ScanResult, ScannerRunSummary, ScannerSource } from "@openqodex/core";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

// A custom scanner prepared by the custom module. `skipped` is set when the
// entry must not run (untrusted, changed since approval); the runner then
// records that summary and never calls `run`.
export type CustomAdapter = {
  source: ScannerSource;
  skipped: ScannerRunSummary | null;
  wants(changedPaths: string[]): boolean;
  run(args: { repoDir: string; changedPaths: string[] }): Promise<AdapterResult & { version: string | null }>;
};

export type RunScannersResult = {
  scan: ScanResult;
  // Raw matched secrets, in memory only, for redacting the brief. Never persist.
  secrets: string[];
};

export function runScanners(_args: {
  repoDir: string;
  changedPaths: string[];
  coverage: DiffCoverage;
  config: Config;
  resolveTool: ResolveTool;
  custom?: CustomAdapter[];
  only?: ScannerSource[];
  skip?: ScannerSource[];
  onProgress?: (line: string) => void;
}): Promise<RunScannersResult> {
  return notBuilt("runScanners");
}
