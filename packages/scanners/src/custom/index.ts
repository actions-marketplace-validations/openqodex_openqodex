// Custom scanners from .openqodex.yaml: resolving what an entry would run,
// the developer's approval, and the adapters the runner calls. An entry runs
// only while the approval recorded for this repo matches its exact contents;
// before that nothing from it is executed or installed onto a tool path.
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { OpenQodexError, customEntryHash, matchesGlob } from "@openqodex/core";
import type { Config, CustomScanner, ScannerSource, StaticFinding } from "@openqodex/core";
import { describeFailure, execTool, stderrTail } from "../exec.js";
import { parseJsonMap } from "../formats/json-map.js";
import { parseSarif } from "../formats/sarif.js";
import type { CustomAdapter } from "../run.js";
import { extractArchive, isRegularFileInside, run, smallEnv, which } from "../toolchain/fetch.js";
import { installTool, npmCommand } from "../toolchain/install.js";
import { openqodexHome, toolsDir, type ArchiveKind } from "../toolchain/table.js";
import { expandArgs, splitCommand } from "./command.js";
import { resolveRelease } from "./release.js";

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

const REPORT_MAX_BYTES = 8 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 20 * 60_000;

// The program named by the run line, before it is replaced by the installed path.
function commandName(entry: CustomScanner): string {
  const first = splitCommand(entry.run)[0];
  if (!first) throw new OpenQodexError(`${entry.name}: run is empty`);
  return first;
}

// Reads the release, picks the asset for this OS and CPU, downloads it to
// quarantine without executing it. Throws OpenQodexError listing the candidate
// assets when none or several match.
export async function resolveCustomArtifact(entry: CustomScanner): Promise<ResolvedArtifact> {
  const name = commandName(entry);
  const install = entry.install;
  switch (install.kind) {
    case "github-release":
      return resolveRelease({ ...entry, install }, install.binary ?? name);
    case "path": {
      const found = which(name);
      if (!found) throw new OpenQodexError(`${entry.name}: ${name} is not on PATH`);
      return { version: entry.version ?? "path", assetName: null, url: null, sha256: null, checksumSource: null, binary: found, quarantinePath: null };
    }
    case "npm":
    case "uv": {
      const version = entry.version ?? specVersion(install.spec, install.kind) ?? "latest";
      return { version, assetName: null, url: null, sha256: null, checksumSource: null, binary: name, quarantinePath: null };
    }
  }
}

function specVersion(spec: string, kind: "npm" | "uv"): string | null {
  if (kind === "uv") return spec.split("==")[1] ?? null;
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(at + 1) : null;
}

// ---------- the trust file ----------

type TrustFile = { version: 1; records: TrustRecord[] };

const trustPath = () => join(openqodexHome(), "trust.json");

function repoKey(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return resolve(repoRoot);
  }
}

function readTrust(): TrustFile {
  const path = trustPath();
  if (!existsSync(path)) return { version: 1, records: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as TrustFile;
    if (!Array.isArray(data.records)) throw new Error("no records");
    return data;
  } catch {
    throw new OpenQodexError(`${path} is not readable: fix or delete it, then run \`openqodex trust\` again`);
  }
}

function writeTrust(file: TrustFile): void {
  const path = trustPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function trustState(repoRoot: string, config: Config): TrustRow[] {
  const key = repoKey(repoRoot);
  const records = readTrust().records.filter((r) => r.repoRoot === key);
  return config.custom.map((entry) => {
    const record = records.find((r) => r.name === entry.name) ?? null;
    const state = record === null ? "untrusted" : record.entryHash === customEntryHash(entry) ? "trusted" : "changed";
    return { entry, state, record };
  });
}

export function revoke(repoRoot: string, name: string): void {
  const key = repoKey(repoRoot);
  const file = readTrust();
  const records = file.records.filter((r) => !(r.repoRoot === key && r.name === name));
  if (records.length !== file.records.length) writeTrust({ ...file, records });
}

// ---------- install on approval ----------

function archiveKind(name: string): ArchiveKind | null {
  if (/\.(tar\.gz|tgz)$/i.test(name)) return "tar.gz";
  if (/\.tar\.xz$/i.test(name)) return "tar.xz";
  if (/\.zip$/i.test(name)) return "zip";
  return null;
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

// Every regular file under `dir` whose name is `name`.
function findFiles(dir: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, name));
    else if (entry.isFile() && entry.name === name) found.push(path);
  }
  return found;
}

const versionFolder = (version: string) => version.replace(/[^A-Za-z0-9._-]/g, "_");

// Unpacks the quarantined download into a staging folder, then moves it into
// place. Returns the absolute path of the binary. Only a regular file the
// checksum covered can become the binary: never a link, never outside.
async function installRelease(entry: CustomScanner, artifact: ResolvedArtifact, final: string): Promise<string> {
  const quarantined = artifact.quarantinePath;
  if (!quarantined || !existsSync(quarantined)) {
    throw new OpenQodexError(`${entry.name}: the download is no longer in quarantine; run \`openqodex trust\` again`);
  }
  if ((await fileSha256(quarantined)) !== artifact.sha256) {
    throw new OpenQodexError(`${entry.name}: the quarantined download changed after it was checked; run \`openqodex trust\` again`);
  }
  const staging = mkdtempSync(join(dirname(final), ".staging-"));
  try {
    const tree = join(staging, "tree");
    mkdirSync(tree);
    const kind = artifact.assetName ? archiveKind(artifact.assetName) : null;
    let binary: string;
    if (kind) {
      await extractArchive(quarantined, kind, tree);
      const wanted = artifact.binary;
      const hits = wanted.includes("/") ? [join(tree, wanted)] : findFiles(tree, wanted);
      if (hits.length !== 1) {
        throw new OpenQodexError(
          `${entry.name}: ${hits.length === 0 ? "no" : "more than one"} file named ${wanted} in ${artifact.assetName}; set install: { binary: "<path inside the archive>" }`,
        );
      }
      binary = hits[0]!;
    } else {
      mkdirSync(join(tree, "bin"));
      binary = join(tree, "bin", basename(artifact.binary));
      renameSync(quarantined, binary);
    }
    if (!isRegularFileInside(binary, tree)) {
      throw new OpenQodexError(`${entry.name}: ${relative(tree, binary)} is not a regular file inside ${artifact.assetName}`);
    }
    chmodSync(binary, 0o755);
    const rel = relative(tree, binary);
    rmSync(final, { recursive: true, force: true });
    renameSync(tree, final);
    return join(final, rel);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// npm and uv tools keep absolute paths in their scripts, so they install in
// place, the same way the pinned toolchain installs them.
async function installPackage(entry: CustomScanner, spec: string, kind: "npm" | "uv", dir: string): Promise<string> {
  const home = openqodexHome();
  const name = commandName(entry);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    let file: string;
    let args: string[];
    let extra: Record<string, string> = {};
    let binary: string;
    if (kind === "npm") {
      const npm = npmCommand();
      if (!npm) throw new OpenQodexError(`${entry.name}: needs npm`);
      file = npm.file;
      args = [...npm.args, "install", "--prefix", dir, "--no-save", "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--cache", join(home, "cache", "npm"), spec];
      binary = join(dir, "node_modules", ".bin", name);
    } else {
      file = which("uv") ?? (await installTool("uv")).path;
      args = ["tool", "install", spec];
      const python = join(toolsDir(home), "uv-python");
      extra = {
        UV_PYTHON_INSTALL_DIR: python,
        UV_PYTHON_BIN_DIR: join(python, "bin"),
        UV_PYTHON_PREFERENCE: "only-managed",
        UV_TOOL_DIR: join(dir, "uv-tools"),
        UV_TOOL_BIN_DIR: join(dir, "bin"),
        UV_CACHE_DIR: join(home, "cache", "uv"),
        UV_NO_PROGRESS: "1",
      };
      binary = join(dir, "bin", name);
    }
    const out = await run(file, args, { cwd: home, env: smallEnv(extra), timeoutMs: INSTALL_TIMEOUT_MS });
    if (out.timedOut) throw new OpenQodexError(`${entry.name}: install not finished after 20 minutes`);
    if (out.code !== 0) throw new OpenQodexError(`${entry.name}: install failed: ${out.stderr.trim().split("\n").pop() ?? `exit ${out.code}`}`);
    // The package manager links the binary; what it points at must be inside the install.
    let real: string;
    try {
      real = realpathSync(binary);
    } catch {
      throw new OpenQodexError(`${entry.name}: ${name} is missing after installing ${spec}`);
    }
    if (!real.startsWith(realpathSync(dir) + sep) || !statSync(real).isFile()) {
      throw new OpenQodexError(`${entry.name}: ${name} does not point at a file inside the install`);
    }
    return binary;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// Records the approval and installs the quarantined artifact.
export async function approve(repoRoot: string, entry: CustomScanner, artifact: ResolvedArtifact): Promise<void> {
  const home = openqodexHome();
  const final = join(home, "tools", "custom", entry.name, versionFolder(artifact.version));
  let binary = artifact.binary;
  const install = entry.install;
  if (install.kind === "github-release") {
    mkdirSync(dirname(final), { recursive: true });
    binary = await installRelease(entry, artifact, final);
    const quarantineRoot = join(home, "quarantine");
    if (artifact.quarantinePath && relative(quarantineRoot, artifact.quarantinePath).split(sep).length === 2) {
      rmSync(dirname(artifact.quarantinePath), { recursive: true, force: true });
    }
  } else if (install.kind === "npm" || install.kind === "uv") {
    binary = await installPackage(entry, install.spec, install.kind, final);
  }
  const key = repoKey(repoRoot);
  const file = readTrust();
  const record: TrustRecord = {
    repoRoot: key,
    name: entry.name,
    entryHash: customEntryHash(entry),
    artifact: { ...artifact, binary, quarantinePath: null },
    approvedAt: new Date().toISOString(),
  };
  writeTrust({ ...file, records: [...file.records.filter((r) => !(r.repoRoot === key && r.name === entry.name)), record] });
}

// ---------- the adapters ----------

function skippedAdapter(source: ScannerSource, reason: string): CustomAdapter {
  return {
    source,
    skipped: { scanner: source, status: "untrusted", version: null, rawCount: 0, keptCount: 0, durationMs: 0, reason },
    wants: () => false,
    run: async () => ({ findings: [], error: null, version: null }),
  };
}

function trustedAdapter(entry: CustomScanner, record: TrustRecord): CustomAdapter {
  const source: ScannerSource = `custom:${entry.name}`;
  const version = record.artifact.version;
  const matching = (paths: string[]) =>
    entry.paths === null ? paths : paths.filter((p) => entry.paths!.some((glob) => matchesGlob(p, glob)));
  return {
    source,
    skipped: null,
    wants: (changedPaths) => matching(changedPaths).length > 0,
    async run({ repoDir, changedPaths }) {
      const tokens = splitCommand(entry.run);
      const usesReport = tokens.some((t) => t.includes("{report}"));
      const tmp = mkdtempSync(join(tmpdir(), "openqodex-custom-"));
      try {
        const report = join(tmp, "report");
        const targets = entry.target === "repo" ? [repoDir] : matching(changedPaths);
        const args = expandArgs(tokens.slice(1), { report, repo: repoDir, targets });
        const timeoutMs = entry.timeoutSeconds * 1000;
        const result = await execTool(record.artifact.binary, args, { cwd: repoDir, timeoutMs, maxBytes: REPORT_MAX_BYTES });
        const failed = describeFailure(entry.name, result, timeoutMs);
        if (failed) return { findings: [], error: failed, version };
        const exit = `exit ${result.exitCode}${stderrTail(result) ? `: ${stderrTail(result)}` : ""}`;
        let text: string;
        if (usesReport) {
          if (!existsSync(report)) return { findings: [], error: `${entry.name} wrote no report (${exit})`, version };
          if (statSync(report).size > REPORT_MAX_BYTES) return { findings: [], error: `${entry.name} report is larger than 8 MB`, version };
          text = readFileSync(report, "utf8");
        } else {
          text = result.stdout;
        }
        let findings: StaticFinding[];
        try {
          findings =
            entry.format === "sarif"
              ? parseSarif(text, { repoDir, source })
              : parseJsonMap(text, entry.map!, { repoDir, source });
        } catch (error) {
          const why = (error as Error).message;
          return { findings: [], error: result.exitCode === 0 ? `${entry.name}: ${why}` : `${entry.name}: ${why} (${exit})`, version };
        }
        // Many tools exit non-zero when they find something; a report that parses is a run.
        return { findings, error: null, version };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

// One adapter per custom entry; an entry that is not approved comes back with `skipped` set.
export function customAdapters(repoRoot: string, config: Config): CustomAdapter[] {
  return trustState(repoRoot, config).map(({ entry, state, record }) => {
    const source: ScannerSource = `custom:${entry.name}`;
    if (state === "untrusted") return skippedAdapter(source, "not approved yet: run `openqodex trust`");
    if (state === "changed" || record === null) return skippedAdapter(source, "changed since it was approved: run `openqodex trust`");
    return trustedAdapter(entry, record);
  });
}
