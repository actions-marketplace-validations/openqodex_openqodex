import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The package root is one level above this file in every layout: the bundle at
// <root>/dist/bin.js (workspace and installed package alike) and the source at
// <root>/src/assets.ts. Assets ship beside dist/, so they are found from here,
// never from the current directory.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function assetPath(...segments: string[]): string {
  return join(packageRoot, ...segments);
}
