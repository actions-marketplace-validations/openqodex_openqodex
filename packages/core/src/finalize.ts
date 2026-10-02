// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Change, Config, Report, RunManifest, ScanResult } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function finalizeReview(_args: {
  change: Change;
  scan: ScanResult;
  manifest: RunManifest;
  config: Config;
  submission: unknown;
}): Report {
  return notBuilt("finalizeReview");
}

export function scanReport(_args: { change: Change; scan: ScanResult; config: Config }): Report {
  return notBuilt("scanReport");
}
