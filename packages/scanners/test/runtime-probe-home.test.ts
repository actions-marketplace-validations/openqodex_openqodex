// The runtime probes (`go env`, `cargo --version`, `rustc --print sysroot`)
// that doctor and the resolver run to find Go and Rust. Each case runs the
// built package in a process of its own, with the real go and cargo found on
// PATH (rustup proxies on most machines); a case whose runtime is absent here
// proves less, and says so in its name's condition. Failures, written before
// the code:
// 1. A probe started with an empty home folder (a server's, a benchmark
//    run's) writes the tools' own state there: rustup's (.rustup), Go's
//    telemetry (Library/Application Support/go on macOS, .config/go
//    elsewhere). The probes run in a home of their own under the OpenQodex
//    home's cache.
// 2. A developer's Rust, kept in the home folder's .rustup and .cargo, is no
//    longer found once the probes run in a home of their own.
// 3. A later review's probe answers point into an earlier review's probe
//    home, which that review removed: a probe's answer is kept per probe
//    home.
// 4. A server run's probe writes outside its scratch root, or fails the
//    scanner when it may not: a run with a scratch root probes there,
//    whatever probe home its resolver would use by default.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// The environment of a process with this home folder, the way a CI runner
// has Rust: no RUSTUP_HOME or CARGO_HOME, so rustup looks in the home folder.
function envWith(home: string, more: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...more };
  delete env.RUSTUP_HOME;
  delete env.CARGO_HOME;
  return env;
}

// Whether a command runs in a throwaway home with that environment.
function runs(command: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  const p = spawnSync(command, args, { env: { ...env, HOME: tempDir("oq-probe-oracle-") }, encoding: "utf8", timeout: 60_000 });
  return p.status === 0;
}

// doctor's view of golangci (needs Go) and cargo-deny (needs Cargo), from
// the built package in a process with `env`.
function statuses(env: NodeJS.ProcessEnv): Record<string, string> {
  const code = `import { toolStatuses } from ${JSON.stringify(DIST)}; const s = await toolStatuses(); process.stdout.write(JSON.stringify(Object.fromEntries(s.filter((x) => x.scanner === "golangci" || x.scanner === "cargo-deny").map((x) => [x.scanner, x.state]))));`;
  const p = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 120_000 });
  if (p.status !== 0) throw new Error(`the probe process failed: ${p.stderr}`);
  return JSON.parse(p.stdout);
}

describe("a runtime probe writes the tools' own state into the home folder", () => {
  it("leaves an empty home folder empty, and finds what the same commands find in a throwaway home", () => {
    const home = tempDir("oq-probe-home-");
    const oqHome = tempDir("oq-probe-oqhome-");
    const env = envWith(home, { OPENQODEX_HOME: oqHome });
    const got = statuses(env);
    expect(readdirSync(home)).toEqual([]);
    if (!runs("go", ["version"], env)) expect(got.golangci).toBe("needs_runtime");
    if (!runs("cargo", ["--version"], env)) expect(got["cargo-deny"]).toBe("needs_runtime");
  }, 180_000);
});

describe("a developer's Rust is no longer found once the probes run in a home of their own", () => {
  // A Rust installed the rustup way somewhere on this machine: the one
  // RUSTUP_HOME names, else the home folder's.
  const rustup = process.env.RUSTUP_HOME || join(homedir(), ".rustup");
  const cargo = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const haveRust = existsSync(join(rustup, "toolchains")) && existsSync(join(cargo, "bin", "cargo"));

  it.skipIf(!haveRust)("finds the toolchain a home folder's .rustup holds", () => {
    // A developer's home whose .rustup and .cargo are that installation.
    const home = tempDir("oq-probe-dev-");
    symlinkSync(rustup, join(home, ".rustup"));
    symlinkSync(cargo, join(home, ".cargo"));
    const env = envWith(home, { OPENQODEX_HOME: tempDir("oq-probe-oqhome-"), PATH: `${join(cargo, "bin")}:${process.env.PATH ?? ""}` });
    expect(statuses(env)["cargo-deny"]).not.toBe("needs_runtime");
    expect(readdirSync(home).sort()).toEqual([".cargo", ".rustup"]);
  }, 180_000);
});

describe("a later review's probe answers point into an earlier review's removed folder", () => {
  const haveGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

  it.skipIf(!haveGo)("probes again for each probe home, and the Go folders it reports lie in that home", async () => {
    const saved = process.env.HOME;
    // A host with no Go folders of its own in its home folder.
    process.env.HOME = tempDir("oq-probe-host-");
    try {
      const { checkRuntime } = await import("../src/toolchain/install.js");
      const { loadToolchain } = await import("../src/toolchain/table.js");
      const recipe = loadToolchain().tools.golangci!;
      const first = tempDir("oq-probe-review1-");
      const second = tempDir("oq-probe-review2-");
      expect((await checkRuntime(recipe, first)).env.GOPATH?.startsWith(first)).toBe(true);
      expect((await checkRuntime(recipe, second)).env.GOPATH?.startsWith(second)).toBe(true);
    } finally {
      process.env.HOME = saved;
    }
  }, 120_000);
});

describe("a server run's runtime probe writes outside its scratch root", () => {
  const haveGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;

  it.skipIf(!haveGo)("probes inside the scratch root while the temp folder, HOME and the OpenQodex home are read-only, and fails no scanner for it", async () => {
    const { runScanners } = await import("../src/run.js");
    const { createToolResolver } = await import("../src/toolchain/index.js");
    const { parseConfig } = await import("@openqodex/core");
    const repo = tempDir("oq-probe-repo-");
    writeFileSync(join(repo, "go.mod"), "module example.com/probe\n\ngo 1.22\n");
    writeFileSync(join(repo, "main.go"), "package main\n\nfunc main() {}\n");
    const installRoot = tempDir("oq-probe-tools-");
    const scratchRoot = join(tempDir("oq-probe-scratch-"), "s");
    const watched = { TMPDIR: tempDir("oq-probe-tmp-"), HOME: tempDir("oq-probe-home-"), OPENQODEX_HOME: tempDir("oq-probe-oqhome-") };
    const saved = Object.fromEntries(Object.keys(watched).map((k) => [k, process.env[k]]));
    Object.assign(process.env, watched);
    for (const dir of Object.values(watched)) chmodSync(dir, 0o555);
    let run;
    try {
      run = await runScanners({ repoDir: repo, changedPaths: ["go.mod", "main.go"], config: parseConfig("").config, resolveTool: createToolResolver({ allowInstall: false, installRoot }), only: ["golangci"], scratchRoot });
    } finally {
      for (const dir of Object.values(watched)) chmodSync(dir, 0o755);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const golangci = run.scan.scanners.find((s) => s.scanner === "golangci");
    // Not installed here, and said so; never a probe that could not write.
    expect(golangci?.status).toBe("not_installed");
    expect(golangci?.reason ?? "").not.toMatch(/EACCES|permission/);
    for (const dir of Object.values(watched)) expect(readdirSync(dir), dir).toEqual([]);
    expect(readdirSync(join(scratchRoot, "cache"))).toContain("runtime-probe");
  }, 120_000);
});
