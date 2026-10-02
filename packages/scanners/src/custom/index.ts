// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Config, CustomScanner } from "@openqodex/core";
import type { CustomAdapter } from "../run.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

// What `openqodex trust` shows before the yes: the exact thing that will run.
export type ResolvedArtifact = {
  version: string;
  assetName: string | null; // null when the binary comes from PATH, npm or uv
  url: string | null;
  sha256: string | null;
  checksumSource: "upstream" | "first-download" | null;
  binary: string;
  quarantinePath: string | null; // the downloaded file, not yet installed or executed
};

export type TrustRecord = {
  repoRoot: string;
  name: string;
  entryHash: string;
  artifact: ResolvedArtifact;
  approvedAt: string;
};

export type TrustRow = {
  entry: CustomScanner;
  state: "trusted" | "untrusted" | "changed";
  record: TrustRecord | null;
};

// Reads the release, picks the asset for this OS and CPU, downloads it to
// quarantine without executing it. Throws OpenQodexError listing the candidate
// assets when none or several match.
export function resolveCustomArtifact(_entry: CustomScanner): Promise<ResolvedArtifact> {
  return notBuilt("resolveCustomArtifact");
}

export function trustState(_repoRoot: string, _config: Config): TrustRow[] {
  return notBuilt("trustState");
}

// Records the approval and installs the quarantined artifact.
export function approve(_repoRoot: string, _entry: CustomScanner, _artifact: ResolvedArtifact): Promise<void> {
  return notBuilt("approve");
}

export function revoke(_repoRoot: string, _name: string): void {
  notBuilt("revoke");
}

// One adapter per custom entry; an entry that is not approved comes back with `skipped` set.
export function customAdapters(_repoRoot: string, _config: Config): CustomAdapter[] {
  return notBuilt("customAdapters");
}
