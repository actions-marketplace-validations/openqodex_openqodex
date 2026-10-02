// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Report } from "../types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export function renderTerminal(_report: Report, _opts: { color: boolean }): string {
  return notBuilt("renderTerminal");
}

export function renderMarkdown(_report: Report): string {
  return notBuilt("renderMarkdown");
}

export function renderJson(_report: Report): string {
  return notBuilt("renderJson");
}

export function renderSarif(_report: Report): string {
  return notBuilt("renderSarif");
}
