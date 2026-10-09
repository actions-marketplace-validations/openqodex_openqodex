// The Kubernetes manifest reader that kube-linter and kubeconform findings
// are anchored with: neither scanner reports a line, only an object (kind,
// name, namespace) and, for kubeconform, a field path such as /spec/replicas.
//
// Failure list, written before the code:
//   1. A finding for the second object of a file lands in the first one
//      (a Deployment and a Service both named web).
//   2. A field path resolves to the wrong line: not the line of its key.
//   3. A sequence index picks the wrong entry, or an indentless sequence
//      (`containers:` then `- name:` at the same column) is not read.
//   4. A field the object does not have anchors anywhere but its nearest
//      ancestor that it does have.
//   5. A `---`, `kind:` or `name:` inside a comment or a block scalar splits
//      a document or renames an object.
//   6. A quoted name or a quoted key is not read.
//   7. A container is looked for in `containers` only, not `initContainers`,
//      or in the wrong pod template for a CronJob.
//   8. A field inside a flow mapping, or in a JSON manifest, is not found,
//      or a path through an alias anchors outside the object's own text.
//   9. A hostile file (many documents, nesting deeper than the parser holds)
//      takes time beyond its length or throws.
//  10. A value the finding names (a port, an environment variable, a host
//      path, a `*` in a flow list) is looked for outside the field it
//      belongs to, or the first copy of a duplicate is taken for the second.
import { describe, expect, it } from "vitest";
import { anchorLine, containerLine, findDocument, kubeDocuments, pathLine, podSpecLine } from "./kube-yaml.js";

const yaml = (...rows: string[]): string => `${rows.join("\n")}\n`;

const TWO = yaml(
  "apiVersion: apps/v1", //  1
  "kind: Deployment", //  2
  "metadata:", //  3
  "  name: web", //  4
  "  namespace: shop", //  5
  "spec:", //  6
  "  replicas: 3", //  7
  "  template:", //  8
  "    spec:", //  9
  "      initContainers:", // 10
  "        - name: setup", // 11
  "          image: busybox:1.36", // 12
  "      containers:", // 13
  "      - name: app", // 14
  "        image: nginx:1.27", // 15
  "        ports:", // 16
  "          - containerPort: 80", // 17
  "          - containerPort: 22", // 18
  "        securityContext:", // 19
  "          privileged: true", // 20
  "---", // 21
  "apiVersion: v1", // 22
  "kind: Service", // 23
  "metadata:", // 24
  "  name: web", // 25
  "spec:", // 26
  "  ports:", // 27
  "    - port: 80", // 28
);

describe("kube-yaml", () => {
  it("a finding for the second object of a file lands in that object, not the first with the same name (1)", () => {
    const docs = kubeDocuments(TWO);
    expect(docs.map((d) => [d.kind, d.name, d.first])).toEqual([
      ["Deployment", "web", 1],
      ["Service", "web", 22],
    ]);
    const service = findDocument(docs, { kind: "Service", name: "web", namespace: "" })!;
    expect(pathLine(service, ["spec", "ports", "0", "port"])).toEqual({ line: 28, found: true });
    const deployment = findDocument(docs, { kind: "Deployment", name: "web", namespace: "shop" })!;
    expect(deployment.first).toBe(1);
  });

  it("a field path resolves to the line of its key (2)", () => {
    const [deployment] = kubeDocuments(TWO);
    expect(pathLine(deployment!, ["spec", "replicas"])).toEqual({ line: 7, found: true });
    expect(pathLine(deployment!, ["metadata", "namespace"])).toEqual({ line: 5, found: true });
  });

  it("a sequence index picks its entry, in an indented and an indentless sequence (3)", () => {
    const [deployment] = kubeDocuments(TWO);
    expect(pathLine(deployment!, ["spec", "template", "spec", "containers", "0", "ports", "1", "containerPort"])).toEqual({ line: 18, found: true });
    expect(pathLine(deployment!, ["spec", "template", "spec", "containers", "0", "securityContext", "privileged"])).toEqual({ line: 20, found: true });
    expect(pathLine(deployment!, ["spec", "template", "spec", "initContainers", "0", "image"])).toEqual({ line: 12, found: true });
  });

  it("a field the object lacks anchors on its nearest ancestor that it has (4)", () => {
    const [deployment] = kubeDocuments(TWO);
    expect(pathLine(deployment!, ["spec", "template", "spec", "containers", "0", "securityContext", "runAsNonRoot"])).toEqual({ line: 19, found: false });
    expect(pathLine(deployment!, ["spec", "template", "spec", "containers", "3", "image"])).toEqual({ line: 13, found: false });
    expect(pathLine(deployment!, ["status"])).toEqual({ line: 1, found: false });
  });

  it("a --- or kind: in a comment or a block scalar neither splits a document nor renames it (5)", () => {
    const text = yaml(
      "# kind: Secret",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: cfg # name: other",
      "data:",
      "  script: |",
      "    ---",
      "    kind: Pod",
      "  next: x",
    );
    const docs = kubeDocuments(text);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: "ConfigMap", name: "cfg", first: 2 });
    expect(pathLine(docs[0]!, ["data", "next"])).toEqual({ line: 10, found: true });
  });

  it("a quoted name and a quoted key are read (6)", () => {
    const text = yaml("apiVersion: v1", 'kind: "Pod"', "metadata:", "  name: 'p1'", "  labels:", '    "app.kubernetes.io/name": x', "spec: {}");
    const [pod] = kubeDocuments(text);
    expect(pod).toMatchObject({ kind: "Pod", name: "p1" });
    expect(pathLine(pod!, ["metadata", "labels", "app.kubernetes.io/name"])).toEqual({ line: 6, found: true });
  });

  it("a container is found by name in initContainers too, and in a CronJob's pod template (7)", () => {
    const [deployment] = kubeDocuments(TWO);
    expect(containerLine(deployment!, "setup")).toBe(11);
    expect(containerLine(deployment!, "app")).toBe(14);
    expect(containerLine(deployment!, "missing")).toBeNull();
    expect(podSpecLine(deployment!)).toBe(9);
    const cron = kubeDocuments(
      yaml(
        "apiVersion: batch/v1",
        "kind: CronJob",
        "metadata:",
        "  name: nightly",
        "spec:",
        "  jobTemplate:",
        "    spec:",
        "      template:",
        "        spec:",
        "          containers:",
        "            - name: run",
        "              image: busybox:1.36",
      ),
    )[0]!;
    expect(podSpecLine(cron)).toBe(9);
    expect(containerLine(cron, "run")).toBe(11);
  });

  it("a field in a flow mapping or a JSON manifest is found, and an alias ends a path on its own line (8)", () => {
    const text = yaml("apiVersion: v1", "kind: Pod", "metadata: {name: p}", "spec:", "  containers:", "    - name: a", "      resources: {limits: {memory: 1Gi}, bogus: 1}");
    const [pod] = kubeDocuments(text);
    expect(pod!.name).toBe("p");
    expect(pathLine(pod!, ["spec", "containers", "0", "resources", "bogus"])).toEqual({ line: 7, found: true });
    expect(pathLine(pod!, ["spec", "containers", "0", "resources", "limits", "cpu"])).toEqual({ line: 7, found: false });
    const json = '{"apiVersion": "v1", "kind": "Service",\n "metadata": {"name": "s\\u0031"},\n "spec": {"ports": [{"port": 80},\n   {"port": 81, "bogus": true}]}}\n';
    const [service] = kubeDocuments(json);
    expect(service).toMatchObject({ kind: "Service", name: "s1", first: 1 });
    expect(pathLine(service!, ["spec", "ports", "1", "bogus"])).toEqual({ line: 4, found: true });
    const aliased = yaml("apiVersion: v1", "kind: Pod", "metadata:", "  name: q", "  labels: &l {app: x}", "spec:", "  nodeSelector: *l");
    expect(pathLine(kubeDocuments(aliased)[0]!, ["spec", "nodeSelector", "app"])).toEqual({ line: 7, found: false });
  });

  it("a value the finding names is found inside its own field only, the last copy when asked (10)", () => {
    const text = yaml(
      "apiVersion: v1", //  1
      "kind: Pod", //  2
      "metadata:", //  3
      "  name: p", //  4
      "  labels:", //  5
      "    port: '22'", //  6
      "spec:", //  7
      "  containers:", //  8
      "    - name: a", //  9
      "      env:", // 10
      "        - name: TOKEN", // 11
      "          value: x", // 12
      "        - name: TOKEN", // 13
      "      ports:", // 14
      "        - containerPort: 80", // 15
      "        - containerPort: 22", // 16
      "---", // 17
      "kind: ClusterRole", // 18
      "metadata:", // 19
      "  name: all", // 20
      "rules:", // 21
      "  - apiGroups: [apps]", // 22
      '    resources: ["*"]', // 23
      "    verbs:", // 24
      '      - "*"', // 25
    );
    const [pod, role] = kubeDocuments(text);
    expect(anchorLine(pod!, { base: "container", paths: [["ports"]], value: { text: "22" } }, "a")).toEqual({ line: 16, found: true });
    expect(anchorLine(pod!, { base: "container", paths: [["env"]], value: { text: "TOKEN", key: "name", last: true } }, "a")).toEqual({ line: 13, found: true });
    expect(anchorLine(pod!, { base: "container", paths: [["volumeMounts"]], value: { text: "22" } }, "a")).toEqual({ line: 9, found: false });
    expect(anchorLine(role!, { base: "object", paths: [["rules"]], value: { text: "*", key: "resources" } }, null)).toEqual({ line: 23, found: true });
    expect(anchorLine(role!, { base: "object", paths: [["rules"]], value: { text: "*" } }, null)).toEqual({ line: 23, found: true });
    expect(anchorLine(role!, { base: "object", paths: [["rules"]], value: { text: "*", key: "verbs" } }, null)).toEqual({ line: 25, found: true });
    expect(anchorLine(role!, { base: "object", paths: [["rules"]], value: { text: "*", key: "apiGroups" } }, null)).toEqual({ line: 21, found: true });
  });

  it("many documents and nesting deeper than the parser holds take time in proportion to the file (9)", () => {
    const doc = yaml("apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: c", "data:", "  a: b");
    const text = `${doc}---\n`.repeat(20_000);
    const deep = `apiVersion: v1\nkind: X\n${Array.from({ length: 2_000 }, (_, i) => `${" ".repeat(i)}k${i}:`).join("\n")}\n`;
    const started = Date.now();
    const docs = kubeDocuments(text);
    expect(docs).toHaveLength(20_000);
    expect(pathLine(docs[19_999]!, ["data", "a"]).found).toBe(true);
    // The parser stops a few hundred levels down; the part it read is kept.
    const [d] = kubeDocuments(deep);
    expect(d!.kind).toBe("X");
    expect(pathLine(d!, Array.from({ length: 200 }, (_, i) => `k${i}`))).toEqual({ line: 202, found: true });
    expect(pathLine(d!, Array.from({ length: 2_000 }, (_, i) => `k${i}`)).line).toBeGreaterThan(202);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
