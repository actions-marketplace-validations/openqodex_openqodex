// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Change, ChangeScope } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function findRepoRoot(_cwd: string): Promise<string> {
  return notBuilt("findRepoRoot");
}

export function getChange(_args: {
  repoRoot: string;
  scope: ChangeScope;
  exclude: string[];
}): Promise<Change> {
  return notBuilt("getChange");
}
