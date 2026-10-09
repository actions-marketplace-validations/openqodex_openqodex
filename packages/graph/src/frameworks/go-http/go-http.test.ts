// The Go net/http plugin on the sample application of the corpus
// (corpus/frameworks/go-http/go-http-app), built as a real git repository
// and run through the whole graph build: the questions a review asks of a
// handler change, answered from the framework layer. Then the facts of one
// file, read from real parse trees, and two crafted repositories that try
// to hang or exhaust the build.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, frameworkLayer } from "../../index.js";
import type { FrameworkLayer, Graph, Registration } from "../../index.js";
import { parserFor } from "../../parser.js";
import type { GoHttpFact } from "./facts.js";
import { MAX_SOURCE_BYTES, readFacts, wants } from "./facts.js";
import { matches, MAX_APPS, MAX_EDGES, MAX_MATCH_WORK, MAX_MIDDLEWARE_CHAIN, MAX_MOUNTS, MAX_REGISTRATIONS, MAX_ROLES, MAX_TEST_REQUESTS, MAX_UNKNOWNS } from "./resolve.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });

function commitAll(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
}

// A repository of generated files, committed.
function writeRepo(prefix: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  commitAll(root);
  return root;
}

const goFacts = async (source: string): Promise<GoHttpFact[]> => {
  const parser = await parserFor("go");
  const tree = parser.parse(source);
  if (!tree) throw new Error("no tree");
  try {
    return readFacts(tree.rootNode);
  } finally {
    tree.delete();
  }
};

// ---------- the sample application ----------

const corpus = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "corpus", "frameworks");

// The id of the one symbol `name` in `file`.
function sym(graph: Graph, file: string, name: string): string {
  const hits = (graph.defsByFile.get(file) ?? []).filter((n) => n.name === name);
  if (hits.length !== 1) throw new Error(`${hits.length} symbols named ${name} in ${file}`);
  return (hits[0] as { id: string }).id;
}

const layer = (g: Graph): FrameworkLayer => {
  const l = frameworkLayer(g);
  if (!l) throw new Error("the graph has no framework layer");
  return l;
};
const regsAt = (g: Graph, site: string): Registration[] =>
  layer(g)
    .registrations()
    .filter((r) => r.plugin === "go-http" && `${r.site.file}:${r.site.line}` === site);
const reg = (g: Graph, site: string): Registration => {
  const found = regsAt(g, site);
  if (found.length !== 1) throw new Error(`${found.length} registrations at ${site}`);
  return found[0] as Registration;
};

const MAIN_MUX = "fw:go-http:app:main.go:12";
const METRICS_MUX = "fw:go-http:app:metrics/metrics.go:7";
const DEFAULT_MUX = "fw:go-http:app:go.mod:1";

describe("the net/http plugin on a small real application", () => {
  let base: Graph;
  let changed: Graph;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-go-http-"));
    cpSync(join(corpus, "go-http", "go-http-app", "base"), root, { recursive: true });
    commitAll(root);
    base = await buildGraph({ repoRoot: root, store: null });
    cpSync(join(corpus, "go-http", "go-http-app", "change"), root, { recursive: true, force: true });
    changed = await buildGraph({ repoRoot: root, store: null });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("answers which route serves a changed handler: GET /items/{id} on the main mux, never the metrics mux's route of the same pattern", () => {
    for (const g of [base, changed]) {
      const getItem = sym(g, "handlers/items.go", "GetItem");
      const routes = layer(g).routesReaching(getItem).routes;
      expect(routes.map((r) => `${r.registration.methods.join(",")} ${r.registration.pattern} ${r.registration.app} ${r.hops}`)).toEqual([`GET /items/{id} ${MAIN_MUX} 0`]);
    }
  });

  it("keeps the metrics mux's GET /items/{id} on its own mux, bound to its own handler", () => {
    const metrics = reg(changed, "metrics/metrics.go:8");
    expect(metrics.app).toBe(METRICS_MUX);
    expect(metrics.handler.status).toBe("bound");
    const routes = layer(changed).routesReaching(sym(changed, "metrics/metrics.go", "itemMetrics")).routes;
    expect(routes.map((r) => r.registration.app)).toEqual([METRICS_MUX]);
  });

  it("keeps the logging middleware on the wrapped admin route and leaves the handler inside the wrapper unbound, with an unknown that names it", () => {
    const admin = reg(changed, "main.go:15");
    expect(admin.handler.status).toBe("unresolved");
    expect(admin.pattern).toBe("/admin/");
    const chain = layer(changed)
      .edgesFrom(admin.id)
      .filter((e) => e.kind === "applies_middleware")
      .map((e) => `${e.order} ${changed.nodes.get(e.to)?.name}`);
    expect(chain).toEqual(["0 logging"]);
    expect(layer(changed).edgesFrom(admin.id).some((e) => e.kind === "handles")).toBe(false);
    const gap = changed.frameworks?.unknowns.find((u) => u.plugin === "go-http" && u.site?.file === "main.go" && u.site.line === 15);
    expect(gap?.cause).toBe("unsupported-rule");
    expect(gap?.name).toBe("handlers.AdminHandler{}");
  });

  it("binds an http.HandlerFunc conversion to the function it converts", () => {
    const routes = layer(changed).routesReaching(sym(changed, "main.go", "serveStatic")).routes;
    expect(routes.map((r) => `${r.registration.pattern} ${r.registration.app}`)).toEqual([`/static/ ${MAIN_MUX}`]);
  });

  it("puts http.HandleFunc on the project's default mux, apart from the main mux, and marks each mux served or not", () => {
    expect(reg(changed, "main.go:21").app).toBe(DEFAULT_MUX);
    const served = Object.fromEntries((changed.frameworks?.apps ?? []).filter((a) => a.plugin === "go-http").map((a) => [a.id, a.data?.served]));
    expect(served).toEqual({ [MAIN_MUX]: true, [DEFAULT_MUX]: true, [METRICS_MUX]: false });
  });

  it("lists a route whose pattern is computed as an unknown that names its handler, never as a registration", () => {
    expect(regsAt(changed, "main.go:19")).toEqual([]);
    const gap = changed.frameworks?.unknowns.find((u) => u.plugin === "go-http" && u.site?.file === "main.go" && u.site.line === 19);
    expect(gap?.cause).toBe("dynamic");
    expect(gap?.name).toBe("healthz");
  });

  it("registers nothing from HandleFunc on a local value named http", () => {
    expect(layer(changed).registrations().filter((r) => r.site.file === "fake/fake.go")).toEqual([]);
    expect((changed.frameworks?.apps ?? []).filter((a) => a.site.file === "fake/fake.go")).toEqual([]);
  });

  it("lists the tests of a handler as a certain direct call and a possible request, never as coverage", () => {
    const links = layer(changed)
      .testsOf(sym(changed, "handlers/items.go", "GetItem"))
      .map((l) => `${l.test.replace(/@.*/, "")} ${l.category} ${l.tier}`)
      .sort();
    expect(links).toEqual(["handlers/items_test.go#TestGetItem direct-call certain", "handlers/items_test.go#TestGetItem route-request possible"]);
  });
});

// ---------- the facts of one file ----------

describe("the net/http facts of one file", () => {
  it("reads no registration from a call written inside a string literal or a comment", async () => {
    const facts = await goFacts(['package main', "", 'import "net/http"', "", "func main() {", '\t// mux.HandleFunc("/x", h)', '\ts := "mux.HandleFunc(\\"/x\\", h)"', "\t/* http.HandleFunc(\"/y\", h) */", "\t_ = s", "}", ""].join("\n"));
    expect(facts.filter((f) => f.kind === "call")).toEqual([]);
  });

  it("reads no call inside a region with a syntax error, and records that the file has one", async () => {
    const facts = await goFacts(["package main", "", 'import "net/http"', "", "func main() {", '\thttp.HandleFunc("/ok", h)', "}", "", "func broken( {", '\thttp.HandleFunc("/broken", h', "}", ""].join("\n"));
    const patterns = facts.flatMap((f) => (f.kind === "call" && f.args[0]?.t === "str" ? [f.args[0].v] : []));
    expect(patterns).toEqual(["/ok"]);
    expect(facts.some((f) => f.kind === "parse-error")).toBe(true);
  });

  it("decodes a pattern's escape sequences from the tree by Go's rules, and takes a raw string as written", async () => {
    const facts = await goFacts(["package main", "", "func main() {", '\tmux.HandleFunc("/caf\\u00e9/\\x41\\101\\t", h)', "\tmux.HandleFunc(`/raw\\n{id}`, h)", '\tmux.HandleFunc("/caf\\xc3\\xa9", h)', "}", ""].join("\n"));
    const patterns = facts.flatMap((f) => (f.kind === "call" && f.args[0]?.t === "str" ? [f.args[0].v] : []));
    expect(patterns).toEqual(["/café/AA\t", "/raw\\n{id}", "/café"]);
  });

  it("treats a name as local only inside the block that declares it, and reads the outer name on the right of its own declaration", async () => {
    const facts = await goFacts(
      ["package main", "", 'import "net/http"', "", "func main() {", "\tif true {", "\t\thttp := fake{}", '\t\thttp.HandleFunc("/inner", h)', "\t}", '\thttp.HandleFunc("/outer", h)', "\thttp := http.NewServeMux()", '\thttp.HandleFunc("/after", h)', "}", ""].join("\n"),
    );
    const calls = facts.flatMap((f) => (f.kind === "call" && f.recv.t === "ref" && f.args[0]?.t === "str" ? [`${f.args[0].v} ${f.recv.local}`] : []));
    expect(calls).toEqual(["/inner true", "/outer false", "/after true"]);
    const callee = facts.flatMap((f) => (f.kind === "value" && f.name === "http" && f.value.t === "call" && f.value.fn.t === "ref" ? [`${f.value.fn.path.join(".")} ${f.value.fn.local}`] : []));
    expect(callee).toEqual(["http.NewServeMux false"]);
  });

  it("reads every Go file, since a package-level value another file uses needs no tell-tale text", () => {
    expect(wants("package util\n\nvar admin = AdminHandler{}\n")).toBe(true);
  });

  it("does not read a file over the byte cap, and says how large it is", async () => {
    const facts = await goFacts(`package main\n${"// padding\n".repeat(Math.ceil(MAX_SOURCE_BYTES / 11) + 10)}`);
    expect(facts).toEqual([{ kind: "too-large", line: 1, column: 1, bytes: expect.any(Number) }]);
  });
});

describe("matching a request to a Go 1.22 pattern", () => {
  it("follows Go's rules: one segment per wildcard, the rest for a last wildcard with dots, the subtree under a trailing slash, the exact path for {$}, and the host", () => {
    expect(matches("/items/{id}", "/items/1")).toBe(true);
    expect(matches("/items/{id}", "/items/1/x")).toBe(false);
    expect(matches("/items/{id}", "/items/")).toBe(false);
    expect(matches("/files/{path...}", "/files/a/b/c")).toBe(true);
    expect(matches("/static/", "/static/css/a.css")).toBe(true);
    expect(matches("/static/", "/static")).toBe(false);
    expect(matches("/", "/anything/at/all")).toBe(true);
    expect(matches("/{$}", "/")).toBe(true);
    expect(matches("/{$}", "/x")).toBe(false);
    expect(matches("api.example.com/v1", "/v1")).toBe(false);
    expect(matches("example.com/v1", "/v1")).toBe(true);
  });
});

// ---------- crafted repositories ----------

const GO_HEAD = 'package main\n\nimport "net/http"\n\n';

function pad(source: string, bytes: number): string {
  const filler = "// padding to reach the size of a large generated route file\n";
  return source + filler.repeat(Math.max(0, Math.ceil((bytes - source.length) / filler.length)));
}

// A request path of 2000 segments, and a pattern of 300 wildcards.
const LONG_PATH = `/${"a/".repeat(2000)}b`;
const WILD = `/${Array.from({ length: 300 }, (_, i) => `{a${i}}`).join("/")}`;

describe("the net/http plugin on a crafted repository", () => {
  const files: Record<string, string> = {};
  let root: string;
  let graph: Graph;
  let factsMs = 0;

  beforeAll(async () => {
    files["go.mod"] = "module example.com/hostile\n\ngo 1.22\n";
    files["h.go"] = `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc wrap(next http.Handler) http.Handler { return next }\n\nfunc main() {}\n`;
    // Three thousand muxes, each mounting the next; the last mounts the first again.
    const N = 3000;
    for (let k = 0; k < 4; k++) {
      const lines = [GO_HEAD];
      for (let i = k * 750; i < (k + 1) * 750; i++) lines.push(`var c${i} = http.NewServeMux()`);
      lines.push("", "func init() {");
      for (let i = k * 750; i < (k + 1) * 750; i++) lines.push(i === N - 1 ? `\tc${i}.Handle("/loop/", c0)\n\tc${i}.HandleFunc("/end", h)` : `\tc${i}.Handle("/c/", c${i + 1})`);
      lines.push("}");
      files[`chain${k}.go`] = lines.join("\n");
    }
    // Twelve thousand registrations on one mux, over eight files.
    for (let k = 0; k < 8; k++) {
      const lines = [GO_HEAD, k === 0 ? "var Big = http.NewServeMux()\n" : "", `func init() {`];
      for (let i = 0; i < 1500; i++) lines.push(`\tBig.HandleFunc("/b${k * 1500 + i}/{id}", h)`);
      lines.push("}");
      files[`zbig${k}.go`] = lines.join("\n");
    }
    // A pattern of hundreds of wildcards, and a handler inside 80 nested wrappers.
    files["wild.go"] = `${GO_HEAD}var W = http.NewServeMux()\n\nfunc init() {\n\tW.HandleFunc(${JSON.stringify(WILD)}, h)\n}\n`;
    files["deep.go"] = `${GO_HEAD}var D = http.NewServeMux()\n\nfunc init() {\n\tD.Handle("/deep", ${"wrap(".repeat(80)}http.HandlerFunc(h)${")".repeat(80)})\n}\n`;
    // Thousands of test requests against thousands of routes, one of them a path of 2000 segments.
    for (let k = 0; k < 3; k++) {
      const lines = ['package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n', `func TestR${k}(t *testing.T) {`, `\thttptest.NewRequest("GET", ${JSON.stringify(LONG_PATH)}, nil)`];
      for (let i = 0; i < 1000; i++) lines.push(`\thttptest.NewRequest("GET", "/b${i}/7", nil)`);
      lines.push("}");
      files[`zreq${k}_test.go`] = lines.join("\n");
    }
    // Over the byte cap: not read, and said so.
    files["huge.go"] = pad(`${GO_HEAD}var H = http.NewServeMux()\n\nfunc init() {\n\tH.HandleFunc("/huge", h)\n}\n`, MAX_SOURCE_BYTES + 64 * 1024);
    const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0);
    expect(total).toBeGreaterThan(1024 * 1024);
    root = writeRepo("oq-go-hostile-", files);

    const parser = await parserFor("go");
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith(".go")) continue;
      const tree = parser.parse(content);
      if (!tree) throw new Error(`no tree for ${path}`);
      const t0 = performance.now();
      readFacts(tree.rootNode);
      factsMs += performance.now() - t0;
      tree.delete();
    }
    graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * 1024 * 1024, budgetMs: 120_000 });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const mine = () => ({
    unknowns: graph.frameworks?.unknowns.filter((u) => u.plugin === "go-http") ?? [],
    registrations: graph.frameworks?.entities.filter((e): e is Registration => e.kind === "registration" && e.plugin === "go-http") ?? [],
    edges: graph.frameworks?.edges.filter((e) => e.plugin === "go-http") ?? [],
  });

  it("a crafted repository cannot hang or exhaust the build: the facts of more than 1 MiB of route files read in under a second", () => {
    expect(factsMs).toBeLessThan(1000);
  });

  it("a crafted repository cannot hang or exhaust the build: the plugin resolves it in under a second", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "go-http");
    console.log(`go-http on the crafted repository: facts ${Math.round(factsMs)} ms, resolve ${run?.ms} ms`);
    expect(run?.status).toBe("ok");
    expect(run?.ms ?? Infinity).toBeLessThan(1000);
  });

  it("stops at the build's registration and mount caps, with one unknown each", () => {
    const { unknowns, registrations, edges } = mine();
    expect(registrations.length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    expect(edges.filter((e) => e.kind === "mounts").length).toBeLessThanOrEqual(MAX_MOUNTS);
    const capped = unknowns.filter((u) => u.cause === "fan-out-capped" && "build" in u.scope);
    expect(capped.filter((u) => u.note.includes(`registrations after ${MAX_REGISTRATIONS} `)).length).toBe(1);
    expect(capped.filter((u) => u.note.includes(`mounted muxes after ${MAX_MOUNTS} `)).length).toBe(1);
  });

  it("stops a mount chain that loops back on itself without repeating it", () => {
    const end = mine().registrations.filter((r) => r.site.file === "chain3.go");
    expect(new Set(end.map((r) => r.id)).size).toBe(end.length);
    for (const r of end) expect(r.mountedVia.length).toBeLessThanOrEqual(8);
  });

  it("caps the middleware chain of one route and says so", () => {
    const deep = mine().registrations.find((r) => r.site.file === "deep.go");
    const chain = mine().edges.filter((e) => e.kind === "applies_middleware" && e.from === deep?.id);
    expect(chain.length).toBe(MAX_MIDDLEWARE_CHAIN);
    expect(mine().unknowns.some((u) => u.cause === "fan-out-capped" && u.site?.file === "deep.go" && u.note.includes("middleware"))).toBe(true);
  });

  it("stops matching test requests at the build's match budget, with one unknown", () => {
    expect(mine().unknowns.filter((u) => u.cause === "budget" && u.note.includes(String(MAX_MATCH_WORK))).length).toBe(1);
  });

  it("does not read a file over the byte cap, and says so with an unknown", () => {
    const gap = mine().unknowns.find((u) => u.cause === "file-not-parsed" && u.site?.file === "huge.go");
    expect(gap?.note).toContain(String(MAX_SOURCE_BYTES));
    expect(mine().registrations.some((r) => r.site.file === "huge.go")).toBe(false);
  });

  it("matches a request against a pattern of hundreds of wildcards within 50 ms, with no regular expression", () => {
    const t0 = performance.now();
    expect(matches(WILD, LONG_PATH)).toBe(false);
    expect(matches(WILD, `/${"x/".repeat(299)}x`)).toBe(false);
    expect(matches("/{rest...}", LONG_PATH)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

// The same work split over hundreds of files, each with a small mux of its
// own: no single mux or file comes near a cap, and the build caps still stop it.
describe("the net/http plugin on work split over hundreds of small muxes", () => {
  let root: string;
  let graph: Graph;

  beforeAll(async () => {
    const files: Record<string, string> = {};
    files["go.mod"] = "module example.com/spread\n\ngo 1.22\n";
    const leaves = [GO_HEAD, "func h(w http.ResponseWriter, r *http.Request) {}\n", "func main() {}\n"];
    for (let j = 0; j < 20; j++) leaves.push(`var l${j} = http.NewServeMux()\n\nfunc init() { l${j}.HandleFunc("/leaf", h) }\n`);
    files["leaves.go"] = leaves.join("\n");
    // 400 muxes of 30 routes and 6 mounts each: 12000 routes and 2400 mounts in all.
    for (let i = 0; i < 400; i++) {
      const lines = [GO_HEAD, `var m${i} = http.NewServeMux()\n`, "func init() {"];
      for (let r = 0; r < 30; r++) lines.push(`\tm${i}.HandleFunc("/r${r}/{id}", h)`);
      for (let s = 0; s < 6; s++) lines.push(`\tm${i}.Handle("/s${s}/", l${(i + s) % 20})`);
      lines.push("}");
      files[`m${String(i).padStart(3, "0")}.go`] = lines.join("\n");
    }
    // A second project with one route and 2400 test requests over 30 files.
    // Its folder sorts first: the caps count work in order across the whole
    // build, so a mux composed after the registration cap has no routes.
    files["areqs/go.mod"] = "module example.com/reqs\n\ngo 1.22\n";
    files["areqs/main.go"] = `${GO_HEAD}func ping(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("GET /ping", ping)\n\thttp.ListenAndServe(":8080", mux)\n}\n`;
    for (let k = 0; k < 30; k++) {
      const lines = ['package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n', `func TestPing${k}(t *testing.T) {`];
      for (let i = 0; i < 80; i++) lines.push(`\thttptest.NewRequest("GET", "/ping", nil)`);
      lines.push("}");
      files[`areqs/r${String(k).padStart(2, "0")}_test.go`] = lines.join("\n");
    }
    root = writeRepo("oq-go-spread-", files);
    graph = await buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a crafted repository cannot hang or exhaust the build: work split over hundreds of muxes still stops at each build cap, with one unknown each, in under a second", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "go-http");
    console.log(`go-http on work split over hundreds of muxes: resolve ${run?.ms} ms`);
    expect(run?.status).toBe("ok");
    expect(run?.ms ?? Infinity).toBeLessThan(1000);
    const regs =graph.frameworks?.entities.filter((e) => e.kind === "registration" && e.plugin === "go-http") ?? [];
    expect(regs.length).toBe(MAX_REGISTRATIONS);
    const mounts = graph.frameworks?.edges.filter((e) => e.plugin === "go-http" && e.kind === "mounts") ?? [];
    expect(mounts.length).toBe(MAX_MOUNTS);
    const requests = graph.frameworks?.edges.filter((e) => e.plugin === "go-http" && e.kind === "tests" && e.category === "route-request") ?? [];
    expect(new Set(requests.map((e) => `${e.evidence.site.file}:${e.evidence.site.line}`)).size).toBe(MAX_TEST_REQUESTS);
    const capped = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "go-http" && u.cause === "fan-out-capped");
    expect(capped.filter((u) => u.note.includes(`registrations after ${MAX_REGISTRATIONS} `)).length).toBe(1);
    expect(capped.filter((u) => u.note.includes(`mounted muxes after ${MAX_MOUNTS} `)).length).toBe(1);
    expect(capped.filter((u) => u.note.includes(`test requests after ${MAX_TEST_REQUESTS} `)).length).toBe(1);
  });
});

// ---------- small repositories, one rule each ----------

// The graph of a committed repository of these files; the folder is removed after.
async function graphOf(files: Record<string, string>): Promise<Graph> {
  const root = writeRepo("oq-go-small-", { "go.mod": "module example.com/small\n\ngo 1.22\n", ...files });
  try {
    return await buildGraph({ repoRoot: root, store: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const goRegs = (g: Graph): Registration[] => (g.frameworks?.entities ?? []).filter((e): e is Registration => e.kind === "registration" && e.plugin === "go-http");

describe("the net/http plugin on small repositories", () => {
  it("never moves a registration to a mux declared in a block that has closed", async () => {
    const g = await graphOf({
      "main.go": `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tif true {\n\t\tmux := http.NewServeMux()\n\t\tmux.HandleFunc("/inner", h)\n\t}\n\tmux.HandleFunc("/outer", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n`,
    });
    const apps = Object.fromEntries(goRegs(g).map((r) => [r.pattern, r.app]));
    expect(apps).toEqual({ "/inner": "fw:go-http:app:main.go:10", "/outer": "fw:go-http:app:main.go:8" });
    const served = (g.frameworks?.apps ?? []).filter((a) => a.plugin === "go-http" && a.data?.served).map((a) => a.id);
    expect(served).toEqual(["fw:go-http:app:main.go:8"]);
  });

  it("never takes a parameter, a block local or a local named httptest for the standard library", async () => {
    const g = await graphOf({
      "main.go": [
        GO_HEAD,
        "type fake struct{}\n",
        "func (fake) HandleFunc(p string, f func(http.ResponseWriter, *http.Request)) {}\n",
        "func h(w http.ResponseWriter, r *http.Request) {}\n",
        "func register(http fake) {\n\thttp.HandleFunc(\"/param\", h)\n}\n",
        "func blocks() {\n\tif true {\n\t\thttp := fake{}\n\t\thttp.HandleFunc(\"/blocked\", h)\n\t}\n\thttp.HandleFunc(\"/after\", h)\n}\n",
        'func main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("/real", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n',
      ].join("\n"),
      "main_test.go": [
        'package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n',
        "type recorder struct{}\n",
        "func (recorder) NewRequest(m, p string, b any) {}\n",
        'func TestShadowed(t *testing.T) {\n\thttptest := recorder{}\n\thttptest.NewRequest("GET", "/real", nil)\n}\n',
        'func TestReal(t *testing.T) {\n\thttptest.NewRequest("GET", "/real", nil)\n}\n',
      ].join("\n"),
    });
    expect(goRegs(g).map((r) => r.pattern).sort()).toEqual(["/after", "/real"]);
    const from = (g.frameworks?.edges ?? []).filter((e) => e.plugin === "go-http" && e.kind === "tests" && e.category === "route-request").map((e) => g.nodes.get(e.from)?.name);
    expect(from).toEqual(["TestReal"]);
  });

  it("says when the matcher could not read a request or a route, instead of reporting no match", async () => {
    const long = `/${Array.from({ length: 70 }, (_, i) => `s${i}`).join("/")}`;
    const g = await graphOf({
      "main.go": `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc(${JSON.stringify(long)}, h)\n\tmux.HandleFunc("GET items", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n`,
      "main_test.go": `package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestLong(t *testing.T) {\n\thttptest.NewRequest("GET", ${JSON.stringify(long)}, nil)\n}\n\nfunc TestShort(t *testing.T) {\n\thttptest.NewRequest("GET", "/x", nil)\n}\n`,
    });
    const at = (line: number) =>
      goUnknowns(g)
        .filter((u) => u.site?.file === "main_test.go" && u.site.line === line && u.affects.includes("tests"))
        .map((u) => u.cause)
        .sort();
    expect(at(9)).toEqual(["fan-out-capped"]);
    expect(at(13)).toEqual(["fan-out-capped", "unsupported-rule"]);
  });

  it("says a request target that is neither a path nor an absolute URL is unread, never blaming the segment cap", async () => {
    const g = await graphOf({
      "main.go": `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("/items", h)\n\thttp.ListenAndServe(":8080", mux)\n}\n`,
      "main_test.go": `package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestBare(t *testing.T) {\n\thttptest.NewRequest("GET", "items", nil)\n}\n`,
    });
    const gaps = goUnknowns(g).filter((u) => u.site?.file === "main_test.go" && u.site.line === 9 && u.affects.includes("tests"));
    expect(gaps.map((u) => u.cause)).toEqual(["unsupported-rule"]);
    expect(gaps[0]?.note).not.toContain("segments");
  });

  it("never reads a list cut short by a read limit as complete: a long pattern, a long wrapper chain, a server whose handler lies past the budget", async () => {
    const longPath = `/${"x".repeat(2100)}`;
    const eater = `d(${Array.from({ length: 20 }, () => `d(${Array.from({ length: 20 }, (_, i) => i).join(", ")})`).join(", ")})`;
    const main = [
      "package main", // 1
      "", // 2
      'import "net/http"', // 3
      "", // 4
      "func h(w http.ResponseWriter, r *http.Request) {}", // 5
      "func wrap(next http.Handler) http.Handler { return next }", // 6
      "func d(xs ...int) int { return 0 }", // 7
      "func main() {", // 8
      "\tmux := http.NewServeMux()", // 9
      `\tmux.HandleFunc(${JSON.stringify(longPath)}, h)`, // 10
      `\tmux.Handle("/deep", ${"wrap(".repeat(80)}http.HandlerFunc(h)${")".repeat(80)})`, // 11
      `\tsrv := &http.Server{ReadTimeout: ${eater}, Handler: mux}`, // 12
      "\tsrv.ListenAndServe()", // 13
      "}", // 14
    ].join("\n");
    const test = `package main\n\nimport (\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestLong(t *testing.T) {\n\thttptest.NewRequest("GET", ${JSON.stringify(longPath)}, nil)\n}\n`;
    const g = await graphOf({ "main.go": main, "main_test.go": test });
    const at = (file: string, line: number) => goUnknowns(g).filter((u) => u.site?.file === file && u.site.line === line);
    expect(at("main.go", 10).map((u) => u.cause)).toEqual(["fan-out-capped"]);
    const chain = at("main.go", 11).filter((u) => u.cause === "fan-out-capped");
    expect(chain.map((u) => [u.count, u.exact])).toEqual([[16, true]]);
    expect(at("main.go", 12).map((u) => u.cause)).toEqual(["fan-out-capped"]);
    expect(at("main_test.go", 9).map((u) => u.cause)).toEqual(["fan-out-capped"]);
  });

  it("never lets a route vanish silently because its receiver or its wrapper cannot be bound", async () => {
    const main = [
      "package main", // 1
      "", // 2
      'import "net/http"', // 3
      "", // 4
      "type chiLike struct{}", // 5
      "func (c *chiLike) HandleFunc(p string, f func(http.ResponseWriter, *http.Request)) {}", // 6
      "type server struct {", // 7
      "\trouter *http.ServeMux", // 8
      "\tother  *chiLike", // 9
      "}", // 10
      "func h(w http.ResponseWriter, r *http.Request) {}", // 11
      "func newMux() *http.ServeMux { return http.NewServeMux() }", // 12
      "func wrapWith() func(http.Handler) http.Handler { return nil }", // 13
      "func (s *server) routes() {", // 14
      '\ts.router.HandleFunc("/field", h)', // 15
      '\ts.other.HandleFunc("/chi", h)', // 16
      '\tnewMux().HandleFunc("/made", h)', // 17
      "\tmw := wrapWith()", // 18
      '\ts.router.Handle("/mw", mw(http.HandlerFunc(h)))', // 19
      '\ts.router.Handle("/gone", missingWrap(http.HandlerFunc(h)))', // 20
      '\tmuxes[0].HandleFunc("/indexed", h)', // 21
      "}", // 22
      "var muxes []*http.ServeMux", // 23
    ].join("\n");
    const g = await graphOf({ "main.go": main });
    const at = (line: number) => goUnknowns(g).filter((u) => u.site?.file === "main.go" && u.site.line === line);
    // A receiver typed *http.ServeMux, a field or a call's declared result: listed with no application.
    for (const [pattern, line] of [["/field", 15], ["/made", 17]] as const) {
      const r = goRegs(g).find((x) => x.pattern === pattern);
      expect(r?.app).toBe(null);
      expect(r?.handler.status).toBe("bound");
      expect(at(line).map((u) => u.cause)).toEqual(["dynamic"]);
    }
    // A receiver of another type is no route, and needs no unknown.
    expect(goRegs(g).some((r) => r.pattern === "/chi")).toBe(false);
    expect(at(16)).toEqual([]);
    // A receiver the plugin cannot read is said.
    expect(at(21).map((u) => `${u.cause} ${u.affects.join(",")}`)).toEqual(["no-receiver-type handles"]);
    // A wrapper that cannot be bound hides middleware as well as the handler.
    for (const line of [19, 20]) expect(at(line).some((u) => u.affects.includes("handles") && u.affects.includes("applies_middleware"))).toBe(true);
  });
});

const goUnknowns = (g: Graph) => (g.frameworks?.unknowns ?? []).filter((u) => u.plugin === "go-http");

// A package of thousands of types used as handlers and thousands of test
// functions among tens of thousands of other functions: a lookup that scans
// a file's or a package's symbols once per item is quadratic here.
describe("the net/http plugin on a package of many symbols", () => {
  let graph: Graph;

  beforeAll(async () => {
    const files: Record<string, string> = { "go.mod": "module example.com/many\n\ngo 1.22\n" };
    for (let k = 0; k < 4; k++) {
      const lines = [GO_HEAD];
      for (let n = k * 750; n < (k + 1) * 750; n++) lines.push(`type T${n} struct{}\n\nfunc (T${n}) ServeHTTP(http.ResponseWriter, *http.Request) {}\n`);
      files[`types${k}.go`] = lines.join("\n");
    }
    for (let k = 0; k < 2; k++) {
      const lines = [GO_HEAD, k === 0 ? "var Mux = http.NewServeMux()\n" : "", "func init() {"];
      for (let n = k * 1500; n < (k + 1) * 1500; n++) lines.push(`\tMux.Handle("/t${n}", T${n}{})`);
      lines.push("}");
      files[`routes${k}.go`] = lines.join("\n");
    }
    for (let k = 0; k < 4; k++) {
      const lines = ['package main\n\nimport "testing"\n'];
      for (let n = 0; n < 12000; n++) lines.push(`func a${k}x${n}() {}`);
      for (let n = 0; n < 900; n++) lines.push(`func TestM${k}x${n}(t *testing.T) {}`);
      files[`many${k}_test.go`] = lines.join("\n");
    }
    const root = writeRepo("oq-go-many-", files);
    try {
      graph = await buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("a crafted repository cannot hang or exhaust the build: no lookup scans a file's or a package's symbols once per handler type or test function", () => {
    const run = graph.frameworks?.plugins.find((p) => p.id === "go-http");
    console.log(`go-http on a package of many symbols: resolve ${run?.ms} ms`);
    expect(run?.status).toBe("ok");
    expect(goRegs(graph).filter((r) => r.handler.status === "bound").length).toBe(3000);
    expect((graph.frameworks?.roles ?? []).filter((r) => r.plugin === "go-http" && r.role === "test").length).toBe(3600);
    expect(run?.ms ?? Infinity).toBeLessThan(1000);
  });
});

// Every list the plugin returns grown past its cap by files a stranger
// writes: thousands of muxes, of test functions, of computed patterns, and
// a handler name defined in 60 files, so each route has 60 handles edges.
describe("the net/http plugin on lists grown past every cap", () => {
  let graph: Graph;

  beforeAll(async () => {
    const files: Record<string, string> = { "go.mod": "module example.com/lists\n\ngo 1.22\n" };
    for (let k = 0; k < 3; k++) {
      const lines = [GO_HEAD];
      for (let n = 0; n < 1700; n++) lines.push(`var m${k}x${n} = http.NewServeMux()`);
      files[`muxes${k}.go`] = lines.join("\n");
    }
    files["mux.go"] = `${GO_HEAD}var Mux = http.NewServeMux()\n\nvar v = "1"\n`;
    for (let k = 0; k < 6; k++) {
      const lines = [GO_HEAD, "func init() {"];
      for (let n = 0; n < 1750; n++) lines.push(`\tMux.HandleFunc("/v${k}x${n}/"+v, h)`);
      lines.push("}");
      files[`computed${k}.go`] = lines.join("\n");
    }
    for (let k = 0; k < 60; k++) files[`h${k}.go`] = `${GO_HEAD}func h(w http.ResponseWriter, r *http.Request) {}\n`;
    files["routes.go"] = [GO_HEAD, "func init() {", ...Array.from({ length: 1100 }, (_, n) => `\tMux.HandleFunc("/r${n}", h)`), "}"].join("\n");
    for (let k = 0; k < 6; k++) {
      const lines = ['package main\n\nimport "testing"\n'];
      for (let n = 0; n < 1750; n++) lines.push(`func TestL${k}x${n}(*testing.T) {}`);
      files[`lists${k}_test.go`] = lines.join("\n");
    }
    const root = writeRepo("oq-go-lists-", files);
    try {
      graph = await buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("a crafted repository cannot hang or exhaust the build: every list the plugin returns stops at its cap, with one unknown each", () => {
    const data = graph.frameworks;
    const run = data?.plugins.find((p) => p.id === "go-http");
    expect(run?.status).toBe("ok");
    const apps = (data?.apps ?? []).filter((a) => a.plugin === "go-http");
    const roles = (data?.roles ?? []).filter((r) => r.plugin === "go-http");
    const edges = (data?.edges ?? []).filter((e) => e.plugin === "go-http");
    const unknowns = goUnknowns(graph);
    expect(apps.length).toBe(MAX_APPS);
    expect(roles.length).toBe(MAX_ROLES);
    expect(edges.length).toBeLessThanOrEqual(MAX_EDGES);
    expect(goRegs(graph).length).toBeLessThanOrEqual(MAX_REGISTRATIONS);
    const caps = unknowns.filter((u) => "build" in u.scope);
    expect(unknowns.length - caps.length).toBe(MAX_UNKNOWNS);
    for (const what of ["applications", "roles", "edges", "unknowns"]) expect(caps.filter((u) => u.note.includes(`stopped listing ${what} after`)).length).toBe(1);
  });
});
