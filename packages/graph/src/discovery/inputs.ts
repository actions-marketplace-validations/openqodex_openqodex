// The files the project model may read or look for (projects.ts and the Go
// module reader in build.ts): manifests, tsconfig and jsconfig files and
// every JSON file a relative `extends` can name, workspace files,
// lockfiles and Python requirement files. A kept index is reused only when
// each of these is the same, present or absent, as when it was built: a
// changed `paths` alias, package entry or lockfile changes bindings and
// floors without changing any source file.
import { posix } from "node:path";

const NAMES = new Set([
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "go.mod",
  "go.work",
  "Gemfile",
]);

export function isModelInput(path: string): boolean {
  const base = posix.basename(path);
  return base.endsWith(".json") || NAMES.has(base) || (base.startsWith("requirements") && base.endsWith(".txt"));
}
