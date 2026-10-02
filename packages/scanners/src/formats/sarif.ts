// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { ScannerSource, StaticFinding } from "@openqodex/core";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function parseSarif(_json: string, _opts: { repoDir: string; source: ScannerSource }): StaticFinding[] {
  return notBuilt("parseSarif");
}
