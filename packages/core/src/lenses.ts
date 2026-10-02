// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Change, SelectedLens } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function selectLenses(_change: Change, _dir?: string): SelectedLens[] {
  return notBuilt("selectLenses");
}
