// The repo's config file: every key optional, defaults work with no file at
// all. The file comes from whatever repo the developer cloned, so it is
// untrusted input: unknown keys are ignored with a warning, a wrong type stops
// the run with the key path, and nothing in it runs until `openqodex trust`
// approves.
//
// Keys mirror the hosted product's `.qodex.yaml` where the meaning holds on
// the developer's machine. Hosted keys with no local meaning are read, warned
// about once each and ignored, so one file can serve both.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SEVERITIES } from "./severity.js";
import type { BuiltinScanner, Config, CustomInstall, CustomScanner, JsonMap, LoadedConfig, Severity } from "./types.js";
import { OpenQodexError } from "./types.js";

// Read first. The 0.1.0 location at the repo root is still read when this
// one is absent.
export const CONFIG_FILE = ".openqodex/config.yaml";
export const LEGACY_CONFIG_FILE = ".openqodex.yaml";

export const DEFAULT_CONFIG: Config = {
  blockOnSeverity: null,
  severityThreshold: "minor",
  exclude: [],
  disabledRules: [],
  defaultBase: null,
  includeFixtures: false,
  disabledScanners: [],
  custom: [],
  graph: { enabled: true, budgetMs: 10_000, maxFiles: 4000, maxFileBytes: 512 * 1024 },
};

// Every key of the file in order, with its default as YAML text and one line
// on what it does. The default config text and the key table in
// docs/config.md are both written from this list, and a test holds it equal
// to the schema's keys and to DEFAULT_CONFIG.
export type ConfigKey = { key: string; default: string; description: string };

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "version", default: "1", description: "The file format version. 1 is the only one." },
  {
    key: "review.severity_threshold",
    default: "minor",
    description: "Findings below this severity stay out of the report; one at or above block_on_severity is always shown.",
  },
  {
    key: "review.block_on_severity",
    default: "null",
    description: "Exit 1 and deny the push when a finding on a changed line is at or above this severity; null never blocks.",
  },
  { key: "review.paths.exclude", default: "[]", description: "Globs of files left out of the change." },
  {
    key: "review.disabled_rules",
    default: "[]",
    description: "Globs on a finding's citation, such as gitleaks:generic-api-key or lens:react-*.",
  },
  {
    key: "review.default_base",
    default: "null",
    description: "The branch or ref to diff against when the branch has no upstream; null uses the remote's default branch.",
  },
  {
    key: "review.include_fixtures",
    default: "false",
    description: "Keep scanner findings in test fixtures, mocks and snapshots.",
  },
  { key: "scanners.disable", default: "[]", description: "Built-in scanners to switch off, by name." },
  {
    key: "scanners.custom",
    default: "[]",
    description: "Open source scanners to add by GitHub link; each runs only after openqodex trust.",
  },
  { key: "graph.enabled", default: "true", description: "Show the callers and importers of the changed code in the brief." },
  { key: "graph.budget_ms", default: "10000", description: "Time the code graph may take, in milliseconds." },
  { key: "graph.max_files", default: "4000", description: "Files past this count are left out of the code graph." },
  {
    key: "graph.max_file_bytes",
    default: "524288",
    description: "Files larger than this, in bytes, are left out of the code graph.",
  },
];

// The commented default config, every key present with its default. `init`
// writes it as .openqodex/config.yaml.
export const DEFAULT_CONFIG_YAML = defaultYaml();

function defaultYaml(): string {
  const out = [
    "# OpenQodex settings for this repo. Every key is optional; these are the defaults.",
    "# Each key is explained by: openqodex guide config",
  ];
  let open: string[] = [];
  for (const { key, default: value, description } of CONFIG_KEYS) {
    const parts = key.split(".");
    const parents = parts.slice(0, -1);
    let same = 0;
    while (same < open.length && same < parents.length && open[same] === parents[same]) same++;
    for (let i = same; i < parents.length; i++) out.push(`${"  ".repeat(i)}${parents[i]}:`);
    open = parents;
    const indent = "  ".repeat(parents.length);
    out.push(`${indent}# ${description}`, `${indent}${parts[parts.length - 1]}: ${value}`);
  }
  return `${out.join("\n")}\n`;
}

// Keys of the hosted file that mean nothing on the developer's machine.
// base_branches there picks which pull requests get reviewed, which is not
// a diff base; review.default_base is the local key for that.
const HOSTED_ONLY_REVIEW_KEYS = [
  "enabled",
  "block_pr_merge",
  "allow_approve",
  "authors",
  "base_branches",
  "style_placement_threshold",
];
const HOSTED_ONLY_TOP_KEYS = ["probes"];
const HOSTED_ONLY = "is used by the hosted review only and is ignored";

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
const severityLevel = z.enum(SEVERITIES as [Severity, ...Severity[]]);

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

  const hostedOnly = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, z.unknown().optional()]));
  const positive = z.number().int().positive();

  const file = obj({
    version: z.literal(1).optional(),
    review: obj({
      severity_threshold: severityLevel.optional(),
      block_on_severity: severityLevel.nullish(),
      paths: obj({ exclude: strings.optional() }).optional(),
      disabled_rules: strings.optional(),
      default_base: z.string().trim().min(1, "expected a branch or ref").nullish(),
      include_fixtures: z.boolean().optional(),
      ...hostedOnly(HOSTED_ONLY_REVIEW_KEYS),
    }).optional(),
    scanners: obj({
      disable: z.array(z.enum(BUILTIN_NAMES)).optional(),
      custom: z.array(custom).optional(),
    }).optional(),
    graph: obj({
      enabled: z.boolean().optional(),
      budget_ms: positive.optional(),
      max_files: positive.optional(),
      max_file_bytes: positive.optional(),
    }).optional(),
    ...hostedOnly(HOSTED_ONLY_TOP_KEYS),
  });

  return { file, map, custom };
}

const STRICT = schemas(true);
const STRIPPING = schemas(false);

// Every key path the schema reads, in schema order, leaving out the hosted
// keys that are only warned about. Lists are not walked: a custom scanner's
// keys are documented with the scanner, not in the key table.
export function schemaKeys(): string[] {
  const out: string[] = [];
  const walk = (shape: Record<string, z.ZodType>, prefix: string): void => {
    for (const [key, value] of Object.entries(shape)) {
      let inner: z.ZodType = value;
      while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) inner = inner.unwrap() as z.ZodType;
      if (inner instanceof z.ZodUnknown) continue;
      if (inner instanceof z.ZodObject) walk(inner.shape as Record<string, z.ZodType>, `${prefix}${key}.`);
      else out.push(`${prefix}${key}`);
    }
  };
  walk(STRICT.file.shape as Record<string, z.ZodType>, "");
  return out;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses the text of a config file. `file` names it in error messages.
export function parseConfig(source: string, file: string = CONFIG_FILE): { config: Config; warnings: string[] } {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new OpenQodexError(`${file}: not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (data === null || data === undefined) return { config: structuredClone(DEFAULT_CONFIG), warnings: [] };

  const warnings: string[] = [];
  // The hosted file names the review block pr_review. It is read as review,
  // through a new top-level object so the parsed YAML is never edited, and
  // every message names the key the developer wrote.
  let shown = (path: PropertyKey[]): PropertyKey[] => path;
  if (isRecord(data) && "pr_review" in data) {
    if ("review" in data) fail(file, ["pr_review"], "review and pr_review are the same block; keep only review");
    const { pr_review: review, ...rest } = data;
    data = { ...rest, review };
    shown = (path) => (path[0] === "review" ? ["pr_review", ...path.slice(1)] : path);
    warnings.push("pr_review is the hosted name of the review block; it is read as review");
  }
  function failAt(path: PropertyKey[], message: string): never {
    fail(file, shown(path), message);
  }

  if (isRecord(data)) {
    for (const key of HOSTED_ONLY_TOP_KEYS) if (key in data) warnings.push(`${key} ${HOSTED_ONLY}`);
    if (isRecord(data.review)) {
      for (const key of HOSTED_ONLY_REVIEW_KEYS) {
        if (key in data.review) warnings.push(`${keyPath(shown(["review", key]))} ${HOSTED_ONLY}`);
      }
    }
  }

  const strict = STRICT.file.safeParse(data);
  if (!strict.success) {
    const real = strict.error.issues.find((i) => i.code !== "unrecognized_keys");
    if (real) failAt(real.path, real.message);
    for (const issue of strict.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      for (const key of issue.keys) warnings.push(`unknown key ${keyPath(shown([...issue.path, key]))} is ignored`);
    }
  }
  const result = STRIPPING.file.safeParse(data);
  if (!result.success) failAt(result.error.issues[0].path, result.error.issues[0].message);
  const yaml = result.data;

  const custom = (yaml.scanners?.custom ?? []).map((c, i) => toCustom(file, i, c));
  const seen = new Set<string>();
  custom.forEach((c, i) => {
    if (seen.has(c.name)) fail(file, ["scanners", "custom", i, "name"], `"${c.name}" is used by two entries`);
    seen.add(c.name);
  });

  const graph = DEFAULT_CONFIG.graph;
  return {
    config: {
      blockOnSeverity: yaml.review?.block_on_severity ?? null,
      severityThreshold: yaml.review?.severity_threshold ?? DEFAULT_CONFIG.severityThreshold,
      exclude: yaml.review?.paths?.exclude ?? [],
      disabledRules: yaml.review?.disabled_rules ?? [],
      defaultBase: yaml.review?.default_base ?? null,
      includeFixtures: yaml.review?.include_fixtures ?? false,
      disabledScanners: yaml.scanners?.disable ?? [],
      custom,
      graph: {
        enabled: yaml.graph?.enabled ?? graph.enabled,
        budgetMs: yaml.graph?.budget_ms ?? graph.budgetMs,
        maxFiles: yaml.graph?.max_files ?? graph.maxFiles,
        maxFileBytes: yaml.graph?.max_file_bytes ?? graph.maxFileBytes,
      },
    },
    warnings,
  };
}

function setsThreshold(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return [data.review, data.pr_review].some((block) => isRecord(block) && "severity_threshold" in block);
}

// `--config` wins. Otherwise .openqodex/config.yaml, then the 0.1.0 file at
// the root. With both, the folder file is read and a warning names both, so a
// 0.1.0 repo keeps working once `init` has written the folder file.
export function loadConfig(repoRoot: string, explicitPath?: string): LoadedConfig {
  if (explicitPath !== undefined) {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(repoRoot, explicitPath);
    if (!existsSync(path)) throw new OpenQodexError(`config file not found: ${path}`);
    return { ...parseConfig(readFileSync(path, "utf8"), explicitPath), path };
  }
  const found = [CONFIG_FILE, LEGACY_CONFIG_FILE].filter((name) => existsSync(join(repoRoot, name)));
  if (found.length === 0) return { config: structuredClone(DEFAULT_CONFIG), path: null, warnings: [] };
  const path = join(repoRoot, found[0]);
  const text = readFileSync(path, "utf8");
  const { config, warnings } = parseConfig(text, found[0]);
  // The threshold default went from info to minor after 0.1.0; a file from
  // then that never set it would lose findings without a word.
  if (found[0] === LEGACY_CONFIG_FILE && !setsThreshold(parseYaml(text))) {
    warnings.push(
      `the report now hides findings below ${DEFAULT_CONFIG.severityThreshold} by default; set review.severity_threshold: info in ${LEGACY_CONFIG_FILE} to keep seeing them`,
    );
  }
  if (found.length === 2) {
    warnings.unshift(
      `both ${CONFIG_FILE} and ${LEGACY_CONFIG_FILE} exist; read ${CONFIG_FILE} only, so move anything still needed from ${LEGACY_CONFIG_FILE} into it and delete it`,
    );
  }
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
