// kubeconform adapter (Kubernetes schema validity): a field the API does not
// have, a value of the wrong type, a required field missing, a file that is
// not YAML. Runs
// `kubeconform -output json -strict -ignore-missing-schemas
//   -kubernetes-version <x.y.z> -schema-location <pinned URL> -cache <folder>
//   -- <files>`
// on the changed YAML files whose content is a Kubernetes object (detect.ts),
// from the repository root. kubeconform reads no settings file.
//
// Schemas: kubeconform downloads the JSON schema of each kind it meets. The
// source is one commit of yannh/kubernetes-json-schema (kubeconform's own
// default source, Apache-2.0) and one Kubernetes version, both pinned in
// toolchain.json, never the default URL on the master branch. Downloads are
// cached under the OpenQodex home, one folder per commit, so a kind is
// fetched once. A kind with no schema there (CustomResourceDefinition, any
// custom resource) is skipped, and asked for again on the next run, since
// kubeconform caches only what it found. `--offline` skips the scanner.
//
// -strict: a field the schema does not name is an error. That is the check
// that catches a field at the wrong level or misspelled; on five public
// manifests (argo-cd, cert-manager, ingress-nginx, microservices-demo,
// guestbook; 156 objects) it reported nothing. -ignore-missing-schemas: those
// same manifests hold 9 CustomResourceDefinitions the schema source has no
// schema for; without it each is an error the change did not cause.
//
// kubeconform reports an object and a field path, never a line, and keeps
// all but the first level of an object's errors in its message text. Each
// error is read from that text and anchored to the line of its field
// (kube-yaml.ts). All errors are captured into the result; the runner never
// throws on a scanner failure.

import path from "node:path";
import { homeGuard } from "@openqodex/core";
import type { AdapterResult, ResolvedTool, ScannerSeverity, StaticFinding } from "@openqodex/core";
import { lstatSync } from "node:fs";
import type { RepoFacts } from "../detect.js";
import { describeFailure, execTool, isOffline, runInChunks, stderrTail } from "../exec.js";
import { safeFileArgs } from "../safe-args.js";
import { loadToolchain, openqodexHome, type SchemaPin } from "../toolchain/table.js";
import type { Adapter } from "./index.js";
import { kubernetesFiles, readManifests } from "./kube-linter.js";
import { findDocument, kubeDocuments, pathLine, type KubeDoc } from "./kube-yaml.js";
import { suchAs } from "./words.js";

const KUBECONFORM_TIMEOUT_MS = 90_000;
const KUBECONFORM_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export const KUBECONFORM_OFFLINE_REASON = "offline, schema downloads are off";

function offlineReason(): string | null {
  return isOffline() ? KUBECONFORM_OFFLINE_REASON : null;
}

// The schema pin from the table, or the reason there is none to use.
function schemaPin(): SchemaPin | string {
  const recipe = loadToolchain().tools.kubeconform;
  const pin = recipe?.method === "github-release" ? recipe.schemas : undefined;
  if (pin === undefined || !/^[0-9a-f]{40}$/.test(pin.commit) || !/^\d+\.\d+\.\d+$/.test(pin.kubernetes) || !/^[\w.-]+\/[\w.-]+$/.test(pin.repo)) {
    return "toolchain.json pins no schema commit and Kubernetes version for kubeconform";
  }
  return pin;
}

export function kubeconformArgs(pin: SchemaPin, cacheDir: string, files: string[]): string[] {
  // The template kubeconform fills per kind; only the commit is ours.
  const location = `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}/{{ .ResourceKind }}{{ .KindSuffix }}.json`;
  return [
    "-output",
    "json",
    "-strict",
    "-ignore-missing-schemas",
    "-kubernetes-version",
    pin.kubernetes,
    "-schema-location",
    location,
    "-cache",
    cacheDir,
    "--",
    ...files,
  ];
}

// The schema cache, one folder per pinned commit, made through the guarded
// writer if it is not there. kubeconform requires it to exist.
function cacheFolder(pin: SchemaPin): string {
  const dir = path.join(openqodexHome(), "cache", "kubeconform", pin.commit);
  let there = false;
  try {
    there = lstatSync(dir).isDirectory();
  } catch {
    // Not there yet.
  }
  if (!there) {
    try {
      homeGuard(openqodexHome(), true).makeFolder(dir);
    } catch (err) {
      // Another run made it in between.
      if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw err;
    }
  }
  return dir;
}

export async function runKubeconform(args: {
  repoDir: string;
  changedPaths: string[];
  tool: ResolvedTool | null;
  facts: RepoFacts;
}): Promise<AdapterResult> {
  const files = kubernetesFiles(args.changedPaths, args.facts);
  if (files.length === 0) return { findings: [], error: null };
  const skipped = offlineReason();
  if (skipped) return { findings: [], error: null, skipped };
  if (!args.tool) return { findings: [], error: "not installed" };
  const tool = args.tool;
  const pin = schemaPin();
  if (typeof pin === "string") return { findings: [], error: pin };
  const texts = await readManifests(args.repoDir, files);
  try {
    const cacheDir = cacheFolder(pin);
    const notes: string[] = [];
    const findings = await runInChunks("kubeconform", safeFileArgs(files), KUBECONFORM_TIMEOUT_MS, async (chunk, left) => {
      const run = await execTool(tool.path, kubeconformArgs(pin, cacheDir, chunk), {
        cwd: args.repoDir,
        timeoutMs: left,
        maxBytes: KUBECONFORM_OUTPUT_MAX_BYTES,
        env: tool.env,
      });
      const failed = describeFailure("kubeconform", run, KUBECONFORM_TIMEOUT_MS);
      if (failed) throw new Error(failed);
      // Exit 0: every object valid. Exit 1: a report with what is not. With
      // nothing on stdout, it did not run.
      if (!run.stdout.trim()) throw new Error(`kubeconform exit ${run.exitCode}: ${stderrTail(run)}`);
      let parsed: ReturnType<typeof parseKubeconformJson>;
      try {
        parsed = parseKubeconformJson(run.stdout, { text: (rel) => texts.get(rel) ?? null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`parse: exit ${run.exitCode}, ${message.slice(0, 200)}`);
      }
      if (parsed.failed !== null) notes.push(parsed.failed);
      return parsed.findings;
    });
    return { findings, error: notes.length > 0 ? notes[0]!.slice(0, 300) : null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { findings: [], error: message.slice(0, 300) };
  }
}

export const kubeconform: Adapter = {
  source: "kubeconform",
  files: (changedPaths, facts) => safeFileArgs(kubernetesFiles(changedPaths, facts)),
  why: (files) => `Kubernetes manifests, ${suchAs(files)}`,
  skip: offlineReason,
  run: (args) => runKubeconform(args),
};

type KubeconformResource = {
  filename?: unknown;
  kind?: unknown;
  name?: unknown;
  status?: unknown;
  msg?: unknown;
  validationErrors?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// The errors kubeconform could not check past: the schema was not there to
// read. Anything else it reports for an object is about the object.
const SCHEMA_TROUBLE = /^(failed downloading schema|error while downloading schema|could not find schema|failed parsing schema|failed to compile schema|failed initialising schema)/;

// The leaf errors in a message: "... - at '/spec/replicas': got string, want
// null or integer   - at '/spec/template/spec': validation failed ...".
// Each path is a JSON pointer (`~1` is `/`). "validation failed" only
// introduces the errors under it.
function leafErrors(msg: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const parts = msg.split(/\s- at '/);
  for (const part of parts.slice(1)) {
    const end = part.indexOf("': ");
    if (end < 0) continue;
    const text = part.slice(end + 3).trim();
    if (text === "validation failed") continue;
    out.push({ path: part.slice(0, end), text });
  }
  return out;
}

function ruleFor(text: string): { rule: string; severity: ScannerSeverity } {
  if (text.startsWith("additional properties")) return { rule: "additional-properties", severity: "medium" };
  if (text.startsWith("got ")) return { rule: "type", severity: "high" };
  if (text.startsWith("missing propert")) return { rule: "required", severity: "high" };
  if (text.startsWith("value must be")) return { rule: "enum", severity: "high" };
  return { rule: "schema", severity: "medium" };
}

export function parseKubeconformJson(
  json: string,
  opts: { text: (rel: string) => string | null },
): { findings: StaticFinding[]; failed: string | null } {
  const findings: StaticFinding[] = [];
  let failed: string | null = null;
  if (!json.trim()) return { findings, failed };
  const parsed = JSON.parse(json) as { resources?: unknown };
  if (!parsed || !Array.isArray(parsed.resources)) return { findings, failed };
  const docs = new Map<string, { text: string; docs: KubeDoc[] } | null>();
  const fileOf = (rel: string) => {
    if (!docs.has(rel)) {
      const text = opts.text(rel);
      docs.set(rel, text === null ? null : { text, docs: kubeDocuments(text) });
    }
    return docs.get(rel)!;
  };
  for (const raw of parsed.resources as KubeconformResource[]) {
    if (!raw || typeof raw !== "object") continue;
    const rel = path.normalize(str(raw.filename));
    const status = str(raw.status);
    const msg = str(raw.msg);
    if (!rel || rel === ".") continue;
    if (status === "statusError") {
      if (SCHEMA_TROUBLE.test(msg)) {
        failed ??= msg;
        continue;
      }
      // Not YAML, or a document with no kind or apiVersion: kubeconform
      // cannot say which document, so the finding spans the file.
      const file = fileOf(rel);
      const last = file === null ? 1 : Math.max(1, file.text.split("\n").length - (file.text.endsWith("\n") ? 1 : 0));
      findings.push({
        source: "kubeconform",
        ruleId: "invalid-yaml",
        filePath: rel,
        lineStart: 1,
        lineEnd: last,
        severity: "high",
        message: trimMessage(`This file does not read as Kubernetes objects: ${msg}`),
        reference: "https://github.com/yannh/kubeconform",
      });
      continue;
    }
    if (status !== "statusInvalid") continue;
    const kind = str(raw.kind);
    const name = str(raw.name);
    const file = fileOf(rel);
    const doc = file === null ? null : findDocument(file.docs, { kind, name, namespace: "" });
    let leaves = leafErrors(msg);
    if (leaves.length === 0 && Array.isArray(raw.validationErrors)) {
      leaves = (raw.validationErrors as { path?: unknown; msg?: unknown }[])
        .map((e) => ({ path: str(e?.path), text: str(e?.msg) }))
        .filter((e) => e.text !== "" && e.text !== "validation failed");
    }
    for (const leaf of leaves) {
      const segments = leaf.path
        .split("/")
        .slice(1)
        .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
      // An extra field is anchored on itself, not on the object holding it.
      const extra = /^additional properties '([^']+)'/.exec(leaf.text)?.[1];
      if (extra !== undefined) segments.push(extra);
      const line = doc === null ? 1 : pathLine(doc, segments).line;
      const { rule, severity } = ruleFor(leaf.text);
      findings.push({
        source: "kubeconform",
        ruleId: rule,
        filePath: rel,
        lineStart: line,
        lineEnd: line,
        severity,
        message: trimMessage(`${kind} ${name}: ${leaf.path || "/"}: ${leaf.text}`),
        reference: "https://kubernetes.io/docs/reference/kubernetes-api/",
      });
    }
  }
  return { findings, failed };
}

function trimMessage(m: string): string {
  const collapsed = m.replace(/\s+/g, " ").trim();
  return collapsed.length > 500 ? collapsed.slice(0, 497) + "..." : collapsed;
}
