// Real binaries on tiny planted inputs for the Kubernetes scanners
// (kube-linter, kubeconform) and the Rust dependency scanner (cargo-deny).
// Each case guards the invocation, the output parser, the changed-line
// filter and tool resolution together; the proxy cases hold the network
// promises in docs/scanners.md. Run by the end-to-end config.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveFirst, scan, withLoggingProxy } from "./subprocess-support.js";
import type { Case } from "./subprocess-support.js";

const here = dirname(fileURLToPath(import.meta.url));

// A Deployment whose container runs privileged.
const PRIVILEGED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27.3
          securityContext:
            privileged: true
`;

// The same Deployment with a string where an integer goes.
const STRING_REPLICAS = PRIVILEGED.replace("replicas: 1", 'replicas: "2"');

const cases: Case[] = [
  { scanner: "kube-linter", rule: "privileged-container", files: { "k8s/web.yaml": PRIVILEGED }, anchor: "k8s/web.yaml" },
  { scanner: "kubeconform", rule: "type", files: { "k8s/web.yaml": STRING_REPLICAS }, anchor: "k8s/web.yaml", network: true },
];

let ran = 0;
let skipped = 0;
afterAll(() => {
  process.stdout.write(`${ran} ran, ${skipped} skipped\n`);
  if (process.env.CI) expect(skipped, "a builtin scanner was skipped under CI").toBe(0);
});

const offline = () => process.env.OPENQODEX_E2E_OFFLINE === "1";

describe("Kubernetes and Rust scanner subprocesses", () => {
  for (const spec of cases)
    it(`${spec.scanner} reports ${spec.rule} on a changed line`, async () => {
      if (spec.network && offline()) {
        skipped++;
        process.stdout.write(`${spec.scanner}: skipped, OPENQODEX_E2E_OFFLINE=1\n`);
        return;
      }
      const result = await scan(spec);
      const status = result.scan.scanners[0]!;
      if (spec.runtime && status.status === "not_installed") {
        expect(status.reason).toMatch(spec.runtime);
        skipped++;
        process.stdout.write(`${spec.scanner}: ${status.reason}\n`);
        return;
      }
      ran++;
      expect(status.status).toBe("ran");
      expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: spec.scanner, ruleId: spec.rule, filePath: spec.anchor }));
    }, 300_000);

  // kube-linter runs only on the changed files, so a check that needs the
  // object a Service selects, kept in another file, would report every
  // Service changed alone. Those checks are not in OpenQodex's set.
  it("kube-linter reports nothing for a Service changed without the Deployment it selects", async () => {
    const service = "apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web\n  ports:\n    - port: 80\n      targetPort: 8080\n";
    const result = await scan({ scanner: "kube-linter", rule: "", files: { "k8s/service.yaml": service }, anchor: "" });
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates.filter((c) => c.source === "kube-linter")).toEqual([]);
  }, 300_000);

  // A repo's .kube-linter.yaml can add a check on kube-linter's kubeconform
  // template, which downloads schemas from any URL it names and makes and
  // writes a cache folder wherever it says. OpenQodex passes its own config,
  // so the planted one neither fetches, nor writes, nor replaces the checks.
  it("kube-linter ignores a planted .kube-linter.yaml that would fetch a URL and write a folder", async () => {
    await resolveFirst("kube-linter");
    const planted = join(tmpdir(), `oq-planted-cache-${randomBytes(6).toString("hex")}`);
    const config = [
      "customChecks:",
      "  - name: planted",
      "    template: kubeconform",
      "    params:",
      '      schemaLocations: ["https://example.com/{{ .ResourceKind }}.json"]',
      `      cache: ${planted}`,
      "checks:",
      "  doNotAutoAddDefaults: true",
      "  include: [planted]",
      "",
    ].join("\n");
    const { result, hosts } = await withLoggingProxy(() =>
      scan({ scanner: "kube-linter", rule: "", files: { ".kube-linter.yaml": config, "k8s/web.yaml": PRIVILEGED }, anchor: "" }),
    );
    expect(result.scan.scanners[0]!.status).toBe("ran");
    expect(result.scan.candidates).toContainEqual(expect.objectContaining({ source: "kube-linter", ruleId: "privileged-container" }));
    expect(hosts).toEqual([]);
    expect(existsSync(planted)).toBe(false);
  }, 300_000);

  // kubeconform downloads schemas from the pinned commit only, and caches
  // them under the OpenQodex home: the second run opens no connection.
  it("kubeconform opens raw.githubusercontent.com on a cold cache and nothing on a warm one", async () => {
    if (offline()) return;
    await resolveFirst("kubeconform");
    // The schema cache of the pinned commit, emptied so the first run is cold.
    const recipe = JSON.parse(readFileSync(join(here, "..", "toolchain.json"), "utf8")).tools.kubeconform;
    rmSync(join(process.env.OPENQODEX_HOME!, "cache", "kubeconform", recipe.schemas.commit), { recursive: true, force: true });
    const spec: Case = { scanner: "kubeconform", rule: "", files: { "k8s/web.yaml": STRING_REPLICAS }, anchor: "" };
    const cold = await withLoggingProxy(() => scan(spec));
    expect(cold.result.scan.scanners[0]!.status, cold.result.scan.scanners[0]!.reason ?? "").toBe("ran");
    expect(cold.result.scan.candidates).toContainEqual(expect.objectContaining({ source: "kubeconform", ruleId: "type", lineStart: 6 }));
    expect(cold.hosts).toEqual(["raw.githubusercontent.com"]);
    const warm = await withLoggingProxy(() => scan(spec));
    expect(warm.result.scan.candidates).toContainEqual(expect.objectContaining({ source: "kubeconform", ruleId: "type", lineStart: 6 }));
    expect(warm.hosts).toEqual([]);
  }, 300_000);

  it("kubeconform is skipped with a plain reason when offline", async () => {
    process.env.OPENQODEX_OFFLINE = "1";
    try {
      const result = await scan({ scanner: "kubeconform", rule: "", files: { "k8s/web.yaml": STRING_REPLICAS }, anchor: "" });
      expect(result.scan.scanners[0]).toMatchObject({ status: "disabled", reason: "offline, schema downloads are off" });
    } finally {
      delete process.env.OPENQODEX_OFFLINE;
    }
  }, 300_000);
});
