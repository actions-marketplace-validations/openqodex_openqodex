// `.openqodex.yaml`: every key optional, defaults work with no file at all.
// The file comes from whatever repo the developer cloned, so it is untrusted
// input: unknown keys are ignored with a warning, a wrong type stops the run
// with the key path, and nothing in it runs until `openqodex trust` approves.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SEVERITIES } from "./severity.js";
import type { BuiltinScanner, Config, CustomInstall, CustomScanner, JsonMap, LoadedConfig, Severity } from "./types.js";
import { OpenQodexError } from "./types.js";

export const CONFIG_FILE = ".openqodex.yaml";

export const DEFAULT_CONFIG: Config = {
  blockOnSeverity: null,
  severityThreshold: "info",
  exclude: [],
  disabledRules: [],
  baseBranches: [],
  includeFixtures: false,
  disabledScanners: [],
  custom: [],
  graph: { enabled: true },
};

const BUILTIN: Record<BuiltinScanner, true> = {
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
const BUILTIN_NAMES = Object.keys(BUILTIN) as [BuiltinScanner, ...BuiltinScanner[]];

const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const strings = z.array(z.string());
// YAML reads `version: 1.2` as a number; a version is always text here.
const text = z.union([z.string(), z.number()]).transform(String);
const scannerSeverity = z.enum(["critical", "high", "medium", "low", "info"]);

// Built twice: strict, to name every unknown key, and stripping, to read the
// values. The parsed YAML is never edited, because a YAML alias can share one
// object between two sections.
function schemas(strict: boolean) {
  const obj = strict ? z.strictObject : z.object;

  const map = obj({
    items: z.string(),
    file: z.string(),
    line: z.string(),
    end_line: z.string().nullish(),
    rule: z.string(),
    severity: z.string().nullish(),
    message: z.string(),
    reference: z.string().nullish(),
    severity_map: z.record(z.string(), scannerSeverity).optional(),
  });

  const install = z.union([
    z.literal("path"),
    obj({
      asset: z.string().nullish(),
      binary: z.string().nullish(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 in lowercase hex").nullish(),
      npm: z.string().optional(),
      uv: z.string().optional(),
    }),
  ]);

  const custom = obj({
    source: z.string(),
    run: z.string().trim().min(1, "expected a command"),
    name: z.string().regex(NAME, "expected letters, digits, dot, dash or underscore").optional(),
    version: text.nullish(),
    format: z.enum(["sarif", "json-map"]).optional(),
    map: map.optional(),
    paths: strings.nullish(),
    target: z.enum(["changed", "repo"]).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    install: install.optional(),
  });

  const file = obj({
    version: z.literal(1).optional(),
    review: obj({
      block_on_severity: z.enum(SEVERITIES as [Severity, ...Severity[]]).nullish(),
      paths: obj({ exclude: strings.optional() }).optional(),
      disabled_rules: strings.optional(),
      include_fixtures: z.boolean().optional(),
    }).optional(),
    scanners: obj({
      disable: z.array(z.enum(BUILTIN_NAMES)).optional(),
      custom: z.array(custom).optional(),
    }).optional(),
  });

  return { file, map, custom };
}

const STRICT = schemas(true);
const STRIPPING = schemas(false);

type CustomYaml = z.infer<typeof STRIPPING.custom>;
type MapYaml = z.infer<typeof STRIPPING.map>;

function keyPath(path: PropertyKey[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out === "" ? String(p) : `.${String(p)}`;
  return out === "" ? "(top level)" : out;
}

function fail(file: string, path: PropertyKey[], message: string): never {
  throw new OpenQodexError(`${file}: ${keyPath(path)}: ${message}`);
}

function toInstall(file: string, path: PropertyKey[], raw: CustomYaml["install"]): CustomInstall {
  if (raw === undefined) return { kind: "github-release", asset: null, binary: null, sha256: null };
  if (raw === "path") return { kind: "path" };
  const { npm, uv, ...release } = raw;
  const releaseKeys = Object.values(release).some((v) => v !== undefined && v !== null);
  if ([npm !== undefined, uv !== undefined, releaseKeys].filter(Boolean).length > 1) {
    fail(file, path, "use one of npm, uv, or asset/binary/sha256");
  }
  if (npm !== undefined) return { kind: "npm", spec: npm };
  if (uv !== undefined) return { kind: "uv", spec: uv };
  return {
    kind: "github-release",
    asset: release.asset ?? null,
    binary: release.binary ?? null,
    sha256: release.sha256 ?? null,
  };
}

function toMap(raw: MapYaml): JsonMap {
  return {
    items: raw.items,
    file: raw.file,
    line: raw.line,
    end_line: raw.end_line ?? null,
    rule: raw.rule,
    severity: raw.severity ?? null,
    message: raw.message,
    reference: raw.reference ?? null,
    severity_map: raw.severity_map ?? {},
  };
}

function lastSegment(source: string): string {
  const parts = source.replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}

function toCustom(file: string, index: number, raw: CustomYaml): CustomScanner {
  const at = (...rest: PropertyKey[]): PropertyKey[] => ["scanners", "custom", index, ...rest];
  const install = toInstall(file, at("install"), raw.install);
  if (install.kind === "github-release" && !GITHUB_REPO.test(raw.source)) {
    fail(file, at("source"), "expected a link of the form https://github.com/<owner>/<repo>");
  }
  const name = raw.name ?? lastSegment(raw.source);
  if (!NAME.test(name)) fail(file, at("name"), `"${name}" cannot be used as a name; set name explicitly`);
  const format = raw.format ?? "sarif";
  if (format === "json-map" && raw.map === undefined) fail(file, at("map"), "required when format is json-map");
  return {
    name,
    source: raw.source,
    run: raw.run,
    version: raw.version ?? null,
    format,
    map: raw.map === undefined ? null : toMap(raw.map),
    paths: raw.paths ?? null,
    target: raw.target ?? "changed",
    timeoutSeconds: raw.timeout_seconds ?? 120,
    install,
  };
}

// Parses the text of a config file. `file` names it in error messages.
export function parseConfig(source: string, file: string = CONFIG_FILE): { config: Config; warnings: string[] } {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new OpenQodexError(`${file}: not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (data === null || data === undefined) return { config: { ...DEFAULT_CONFIG }, warnings: [] };

  const strict = STRICT.file.safeParse(data);
  const warnings: string[] = [];
  if (!strict.success) {
    const real = strict.error.issues.find((i) => i.code !== "unrecognized_keys");
    if (real) fail(file, real.path, real.message);
    for (const issue of strict.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      for (const key of issue.keys) warnings.push(`unknown key ${keyPath([...issue.path, key])} is ignored`);
    }
  }
  const result = STRIPPING.file.safeParse(data);
  if (!result.success) fail(file, result.error.issues[0].path, result.error.issues[0].message);
  const yaml = result.data;

  const custom = (yaml.scanners?.custom ?? []).map((c, i) => toCustom(file, i, c));
  const seen = new Set<string>();
  custom.forEach((c, i) => {
    if (seen.has(c.name)) fail(file, ["scanners", "custom", i, "name"], `"${c.name}" is used by two entries`);
    seen.add(c.name);
  });

  return {
    config: {
      blockOnSeverity: yaml.review?.block_on_severity ?? null,
      // The three keys below land with the week 1 config stream; until then they hold their defaults.
      severityThreshold: DEFAULT_CONFIG.severityThreshold,
      exclude: yaml.review?.paths?.exclude ?? [],
      disabledRules: yaml.review?.disabled_rules ?? [],
      baseBranches: [],
      includeFixtures: yaml.review?.include_fixtures ?? false,
      disabledScanners: yaml.scanners?.disable ?? [],
      custom,
      graph: { enabled: true },
    },
    warnings,
  };
}

export function loadConfig(repoRoot: string, explicitPath?: string): LoadedConfig {
  const path =
    explicitPath === undefined
      ? join(repoRoot, CONFIG_FILE)
      : isAbsolute(explicitPath)
        ? explicitPath
        : resolve(repoRoot, explicitPath);
  if (!existsSync(path)) {
    if (explicitPath !== undefined) throw new OpenQodexError(`config file not found: ${path}`);
    return { config: { ...DEFAULT_CONFIG }, path: null, warnings: [] };
  }
  const { config, warnings } = parseConfig(readFileSync(path, "utf8"), explicitPath ?? CONFIG_FILE);
  return { config, path, warnings };
}

// JSON with object keys sorted at every level, so equal values hash equally.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// sha256 of the canonical JSON of the effective config.
export function configHash(config: Config): string {
  return sha256(canonicalJson(config));
}

// sha256 of the canonical JSON of one custom scanner entry.
export function customEntryHash(entry: CustomScanner): string {
  return sha256(canonicalJson(entry));
}
