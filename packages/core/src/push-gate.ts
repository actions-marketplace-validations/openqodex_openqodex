// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Config, Latest, PushDecision, Report } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function checkPush(_args: {
  currentChangeId: string;
  latest: Latest | null;
  report: Report | null;
  config: Config;
}): PushDecision {
  return notBuilt("checkPush");
}
