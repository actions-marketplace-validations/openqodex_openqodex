import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "@openqodex/core";

export const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const bin = join(root, "packages/cli/dist/bin.js");
export const toolsHome = process.env.OPENQODEX_E2E_HOME ?? join(tmpdir(), "openqodex-e2e-home");
const runs = join(root, "tests/e2e/runs");
mkdirSync(runs, { recursive: true });
const sessionFile = join(runs, `.session-${process.ppid}`);
if (!existsSync(sessionFile)) writeFileSync(sessionFile, new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-"));
export const receipt = join(runs, readFileSync(sessionFile, "utf8"));
mkdirSync(receipt, { recursive: true });

export type Result = { status: number | null; stdout: string; stderr: string };
export function run(label: string, cwd: string, args: string[], options: { home?: string; tools?: string; input?: string; timeout?: number; shell?: boolean } = {}): Result {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "oq-e2e-user-"));
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, OPENQODEX_HOME: options.tools ?? toolsHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const command = options.shell ? "sh" : process.execPath;
  const argv = options.shell ? ["-c", args[0]!] : [bin, ...args];
  const p = spawnSync(command, argv, { cwd, env, encoding: "utf8", input: options.input, timeout: options.timeout ?? 300_000, maxBuffer: 16 * 1024 * 1024 });
  const out = { status: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? String(p.error ?? "") };
  const dir = join(receipt, label.replace(/[^a-z0-9_-]/gi, "_"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "command.txt"), `${command} ${argv.join(" ")}\n`);
  writeFileSync(join(dir, "exit-code.txt"), `${out.status ?? "signal"}\n`);
  writeFileSync(join(dir, "stdout.txt"), out.stdout);
  writeFileSync(join(dir, "stderr.txt"), out.stderr);
  return out;
}
export function git(cwd: string, ...args: string[]): string {
  const p = spawnSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "oq-git-home-")), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout;
}
export function demo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-demo-"));
  const target = join(dir, "repo");
  const p = run(`${label}-create`, root, ["demo", target, "--no-install", "--offline"]);
  if (p.status !== 0) throw new Error(p.stderr);
  return target;
}
export function baseline(): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-clean-"));
  cpSync(join(root, "examples/demo-repo/baseline"), dir, { recursive: true });
  git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-qm", "Baseline");
  return dir;
}
export function report(dir: string): Report {
  const latest = JSON.parse(readFileSync(join(dir, ".openqodex/latest.json"), "utf8")) as { dir: string };
  return JSON.parse(readFileSync(join(dir, latest.dir, "report.json"), "utf8")) as Report;
}
export function reportDir(dir: string): string {
  const latest = JSON.parse(readFileSync(join(dir, ".openqodex/latest.json"), "utf8")) as { dir: string };
  return join(dir, latest.dir);
}
export function inventory(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  function walk(at: string): void {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, e.name);
      const rel = relative(dir, path).replaceAll("\\", "/");
      if (rel === ".git" || rel === ".openqodex") continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) found[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  walk(dir); return found;
}
export function offline(): boolean { return process.env.OPENQODEX_E2E_OFFLINE === "1"; }
export function skipNetwork(name: string): boolean {
  if (!offline()) return false;
  process.stdout.write(`${name}: skipped because OPENQODEX_E2E_OFFLINE=1\n`);
  return true;
}
export function printReceipt(): void { process.stdout.write(`Receipt: ${receipt}\n`); }
export function installed(): boolean { return existsSync(join(receipt, "doctor-install", "exit-code.txt")); }
