// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { DiffCoverage } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function parseDiffCoverage(_diff: string): DiffCoverage {
  return notBuilt("parseDiffCoverage");
}

export function unquoteDiffPath(_raw: string): string {
  return notBuilt("unquoteDiffPath");
}
