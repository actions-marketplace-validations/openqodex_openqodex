// Where a scanner run writes. Every folder a run makes or fills is one of
// these, in one of two shapes:
//
//   the laptop: caches kept between runs under the OpenQodex home
//     (<home>/cache/golangci, kubeconform, cargo-deny), and temporary
//     folders (staging copies, owned configs, report folders) in the system
//     temp folder, each removed after use. Scanners get the developer's
//     HOME and TMPDIR.
//   a scratch root, for a server run: everything under the one folder the
//     caller names. Caches go in <root>/cache, temporary folders in
//     <root>/tmp, and every scanner process gets HOME <root>/home and
//     TMPDIR <root>/tmp, so a tool that keeps its own settings or caches
//     keeps them there. Python scanners write no bytecode beside their code
//     and Go keeps its build cache in <root>/cache/go-build, so the install
//     root is only read. Two runs with two roots share no folder.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Guard, homeGuard } from "@openqodex/core";
import { openqodexHome } from "./toolchain/table.js";

export type Scratch = {
  // Caches live in <root>/cache, and a cache folder is made through
  // `guard`, which refuses a link anywhere under the root.
  root: string;
  guard: Guard;
  // Where temporary folders are made.
  temp: string;
  // Variables every scanner process gets on top of its own.
  env: Record<string, string>;
};

// The laptop's places, read when a run starts.
export function laptopScratch(): Scratch {
  const home = openqodexHome();
  return { root: home, guard: homeGuard(home, true), temp: tmpdir(), env: {} };
}

// A run's own places under `root`, made now, readable by this user only.
export function scratchAt(root: string): Scratch {
  const base = resolve(root);
  const temp = join(base, "tmp");
  const home = join(base, "home");
  for (const dir of [base, temp, home]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    root: base,
    guard: new Guard({ repoRoot: null, gitFolders: [], roots: [base], noLinks: true }),
    temp,
    env: { HOME: home, TMPDIR: temp, GOCACHE: join(base, "cache", "go-build"), PYTHONDONTWRITEBYTECODE: "1" },
  };
}
