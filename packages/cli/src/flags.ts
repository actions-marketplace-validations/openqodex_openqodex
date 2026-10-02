// The one flag parser for every command. Global flags are accepted by every
// command; each command names its own extra flags. An unknown flag, a missing
// value or a bad value throws OpenQodexError, which the frame turns into one
// plain line and exit 2.
import { resolve } from "node:path";
import { OpenQodexError } from "@openqodex/core";
import type { BuiltinScanner, ScannerSource } from "@openqodex/core";

export type Format = "terminal" | "markdown" | "json" | "sarif";
const FORMATS: readonly Format[] = ["terminal", "markdown", "json", "sarif"];

export type GlobalFlags = {
  cwd: string;
  config: string | undefined;
  format: Format;
  output: string | undefined;
  color: boolean;
  quiet: boolean;
  verbose: boolean;
  noInstall: boolean;
  offline: boolean;
};

export type Parsed = {
  global: GlobalFlags;
  bools: Set<string>;
  values: Map<string, string>;
  positionals: string[];
};

const GLOBAL_VALUES = ["--cwd", "--config", "--format", "--output"];
const GLOBAL_BOOLS = ["--no-color", "--quiet", "--verbose", "--no-install", "--offline"];

export function parseFlags(
  args: string[],
  spec: { bools?: string[]; values?: string[]; positionals?: number },
): Parsed {
  const boolNames = new Set([...GLOBAL_BOOLS, ...(spec.bools ?? [])]);
  const valueNames = new Set([...GLOBAL_VALUES, ...(spec.values ?? [])]);
  const bools = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (boolNames.has(name)) {
      if (eq !== -1) throw new OpenQodexError(`${name} takes no value`);
      bools.add(name);
    } else if (valueNames.has(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
        throw new OpenQodexError(`${name} needs a value`);
      }
      values.set(name, value);
    } else {
      throw new OpenQodexError(`unknown flag: ${name}`);
    }
  }

  const max = spec.positionals ?? 0;
  if (positionals.length > max) {
    throw new OpenQodexError(`unexpected argument: ${positionals[max]}`);
  }

  const format = values.get("--format") ?? "terminal";
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new OpenQodexError(`--format must be one of ${FORMATS.join(", ")}, not ${format}`);
  }
  const offline = bools.has("--offline");
  // The scanners read this from the environment, so a dependency lookup that
  // would go online is skipped.
  if (offline) process.env.OPENQODEX_OFFLINE = "1";

  const global: GlobalFlags = {
    cwd: resolve(values.get("--cwd") ?? process.cwd()),
    config: values.get("--config"),
    format: format as Format,
    output: values.get("--output"),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !bools.has("--no-color"),
    quiet: bools.has("--quiet"),
    verbose: bools.has("--verbose"),
    noInstall: offline || bools.has("--no-install"),
    offline,
  };
  return { global, bools, values, positionals };
}

// Every builtin scanner, checked against the type so a new one is not missed.
const BUILTINS: Record<BuiltinScanner, true> = {
  semgrep: true,
  gitleaks: true,
  sqllint: true,
  "osv-scanner": true,
  actionlint: true,
  hadolint: true,
  shellcheck: true,
  ruff: true,
  brakeman: true,
  rubocop: true,
  bandit: true,
  oxlint: true,
  golangci: true,
};

// "a,b" for --only and --skip: builtin names or custom:<name>.
export function scannerList(flag: string, value: string | undefined): ScannerSource[] | undefined {
  if (value === undefined) return undefined;
  const names = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const name of names) {
    if (!(name in BUILTINS) && !/^custom:.+/.test(name)) {
      throw new OpenQodexError(`${flag}: unknown scanner ${name} (builtins: ${Object.keys(BUILTINS).join(", ")})`);
    }
  }
  return names as ScannerSource[];
}
