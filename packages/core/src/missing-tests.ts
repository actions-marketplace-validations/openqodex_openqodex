// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).


const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function computeMissingTestSignal(_changedPaths: string[]): boolean {
  return notBuilt("computeMissingTestSignal");
}
