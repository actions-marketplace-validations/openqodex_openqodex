// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Config, CustomScanner, LoadedConfig } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

export const DEFAULT_CONFIG: Config = {
  blockOnSeverity: null,
  exclude: [],
  disabledRules: [],
  includeFixtures: false,
  disabledScanners: [],
  custom: [],
};

export function loadConfig(_repoRoot: string, _explicitPath?: string): LoadedConfig {
  return notBuilt("loadConfig");
}

// sha256 of the canonical JSON of the effective config.
export function configHash(_config: Config): string {
  return notBuilt("configHash");
}

// sha256 of the canonical JSON of one custom scanner entry.
export function customEntryHash(_entry: CustomScanner): string {
  return notBuilt("customEntryHash");
}
