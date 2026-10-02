// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Change, Config, ScanResult, SelectedLens } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

// `secrets` are the raw strings the scanners matched, in memory only; the
// brief must not contain any of them.
export function buildBrief(_args: {
  change: Change;
  scan: ScanResult;
  lenses: SelectedLens[];
  config: Config;
  secrets: string[];
  findingsPath: string;
  finalizeCommand: string;
}): string {
  return notBuilt("buildBrief");
}
