// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { AdapterResult, BuiltinScanner, ResolvedTool } from "@openqodex/core";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export type Adapter = {
  source: BuiltinScanner;
  // True when this scanner has something to check in the change.
  wants(changedPaths: string[], repoDir: string): boolean;
  // `tool` is null only for the in-process sqllint.
  run(args: { repoDir: string; changedPaths: string[]; tool: ResolvedTool | null }): Promise<AdapterResult>;
};

// The ensemble in merge order. The order is load-bearing: dedup ties go to
// the first, so semgrep precedes gitleaks.
export const ADAPTERS: readonly Adapter[] = [];

void notBuilt;
