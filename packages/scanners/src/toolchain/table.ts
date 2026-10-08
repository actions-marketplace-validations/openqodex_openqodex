// The pinned scanner table (toolchain.json) and where installed tools live.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export type ArchiveKind = "tar.gz" | "tar.xz" | "zip";

export type ReleaseAsset = {
  name: string;
  url: string;
  sha256: string;
  archive: ArchiveKind | "none";
  binaryPath: string; // path of the executable inside the archive, or the asset name
};

type RecipeBase = { version: string; binary: string; needs?: string };

export type Recipe =
  | (RecipeBase & { method: "github-release"; repo: string; tag: string; assets: Partial<Record<Platform, ReleaseAsset | null>> })
  | (RecipeBase & { method: "npm"; package: string })
  // `with`: extra packages pinned beside the tool, for a dependency the tool
  // itself leaves unpinned (semgrep needs a setuptools that still ships pkg_resources).
  | (RecipeBase & { method: "uv"; package: string; python: string; with?: string[] })
  | (RecipeBase & { method: "gem"; gems: string[] });

export type Toolchain = { schema: 1; tools: Record<string, Recipe> };

// $OPENQODEX_HOME or ~/.openqodex, always absolute: tools run with the repo
// as their working directory, so a relative home would point somewhere else.
export function openqodexHome(): string {
  const fromEnv = process.env.OPENQODEX_HOME;
  return fromEnv && fromEnv.length > 0 ? resolve(fromEnv) : join(homedir(), ".openqodex");
}

export function toolsDir(home: string): string {
  return join(home, "tools");
}

export function toolDir(home: string, tool: string): string {
  return join(home, "tools", tool);
}

export function versionDir(home: string, tool: string, recipe: Recipe): string {
  return join(home, "tools", tool, recipe.version);
}

// Where the executable sits once installed.
export function binaryPath(home: string, tool: string, recipe: Recipe): string {
  const dir = versionDir(home, tool, recipe);
  return recipe.method === "npm" ? join(dir, "node_modules", ".bin", recipe.binary) : join(dir, "bin", recipe.binary);
}

// Written last by every install; a version folder without it is not installed.
export function markerPath(home: string, tool: string, recipe: Recipe): string {
  return join(versionDir(home, tool, recipe), ".installed");
}

export function currentPlatform(): Platform | null {
  const os = process.platform;
  const arch = process.arch;
  if ((os === "darwin" || os === "linux") && (arch === "arm64" || arch === "x64")) return `${os}-${arch}`;
  return null;
}

// The table ships beside the code in every layout: next to the package root of
// the scanners source and dist, and beside the CLI bundle. Found from this
// file, never from the current directory.
function findTable(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, "toolchain.json");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("toolchain.json is missing from the installed package");
}

let cached: Toolchain | null = null;

export function loadToolchain(): Toolchain {
  cached ??= JSON.parse(readFileSync(findTable(), "utf8")) as Toolchain;
  return cached;
}

// sha256 of the pinned table as shipped: it changes when any pin changes and
// only then, so a cache of the tools folder keyed on it survives a release
// that pins nothing new.
export function toolchainHash(): string {
  return createHash("sha256").update(readFileSync(findTable())).digest("hex");
}
