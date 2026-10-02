// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { BuiltinScanner, ResolveTool, ToolStatus } from "@openqodex/core";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

// $OPENQODEX_HOME or ~/.openqodex.
export function openqodexHome(): string {
  return notBuilt("openqodexHome");
}

// installBudgetMs null means wait for every install to finish.
export function createToolResolver(_opts: {
  allowInstall: boolean;
  installBudgetMs: number | null;
  onProgress?: (line: string) => void;
}): ResolveTool {
  return notBuilt("createToolResolver");
}

export function toolStatuses(): Promise<ToolStatus[]> {
  return notBuilt("toolStatuses");
}

// Installs the named scanners (default: every one this machine supports) and waits.
export function installTools(
  _scanners: BuiltinScanner[] | null,
  _onProgress?: (line: string) => void,
): Promise<ToolStatus[]> {
  return notBuilt("installTools");
}

// Starts the same install in a detached process and returns at once.
export function installToolsDetached(_scanners: BuiltinScanner[] | null): void {
  notBuilt("installToolsDetached");
}

// Streams a URL to `dest`, returns its sha256, throws when `sha256` is given and differs.
export function downloadVerified(_url: string, _sha256: string | null, _dest: string): Promise<{ sha256: string }> {
  return notBuilt("downloadVerified");
}

// Unpacks a tar.gz, tar.xz or zip into `destDir`, refusing members that escape it.
export function extractArchive(_archive: string, _kind: "tar.gz" | "tar.xz" | "zip", _destDir: string): Promise<void> {
  return notBuilt("extractArchive");
}
