// The Django plugin on a small real application and on hostile input.
import { describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import { django } from "../src/frameworks/django/index.js";
import { parserFor } from "../src/parser.js";
import { commitAll, makeRepo } from "./helpers.js";

const MiB = 1024 * 1024;

// Repeats `unit` until the text is just under `bytes`.
function fill(head: string, unit: (i: number) => string, tail: string, bytes: number): string {
  const parts = [head];
  let size = Buffer.byteLength(head) + Buffer.byteLength(tail);
  for (let i = 0; ; i++) {
    const u = unit(i);
    const n = Buffer.byteLength(u);
    if (size + n >= bytes) break;
    parts.push(u);
    size += n;
  }
  parts.push(tail);
  return parts.join("");
}

describe("the Django plugin on hostile input", () => {
  // Backtracking patterns, long routes, includes that multiply, and test
  // requests built to make a regex engine backtrack: a urls module and a
  // test module just under 1 MiB each.
  const urls = fill(
    "from django.urls import include, path, re_path\n\nfrom mysite import views\n\nurlpatterns = [\n",
    (i) => (i % 3 === 0 ? `    re_path(r"^(a+)+$", views.v, name="n${i}"),\n` : i % 3 === 1 ? `    path("${"<path:p>".repeat(8)}x${i}/", views.v),\n` : `    path("m${i}/", include("mysite.more")),\n`),
    "]\n",
    MiB - 1024,
  );
  const more = `from django.urls import include, path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 400 }, (_, i) => `    path("k${i}/", include("mysite.leaf")),\n`).join("")}]\n`;
  const leaf = `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 400 }, (_, i) => `    path("l${i}/<int:x>/", views.v),\n`).join("")}]\n`;
  const tests = fill(
    "from django.test import TestCase\n\n\nclass T(TestCase):\n    def test_x(self):\n",
    () => `        self.client.get("/${"a".repeat(400)}!")\n`,
    "",
    MiB - 1024,
  );
  const files: Record<string, string> = {
    "requirements.txt": "Django==5.0\n",
    "mysite/__init__.py": "",
    "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n',
    "mysite/urls.py": urls,
    "mysite/more.py": more,
    "mysite/leaf.py": leaf,
    "mysite/views.py": "def v(request, **kw):\n    return None\n",
    "mysite/tests.py": tests,
  };

  it("reads the facts of a 1 MiB hostile urls module and test module in under a second each", async () => {
    const parser = await parserFor("python");
    for (const source of [urls, tests]) {
      const tree = parser.parse(source);
      if (!tree) throw new Error("no tree");
      const started = performance.now();
      django.facts(tree.rootNode, "python");
      const ms = performance.now() - started;
      tree.delete();
      expect(ms).toBeLessThan(1000);
    }
    parser.delete();
  }, 60_000);

  it("resolves hostile routes, multiplying includes and backtracking requests in under a second, with every cap named as a gap", async () => {
    const root = makeRepo(files);
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * MiB, budgetMs: 120_000 });
    const data = graph.frameworks;
    expect(data?.plugins.find((p) => p.id === "django")?.status).toBe("ok");
    expect(graph.status.stages.frameworks ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
    // The includes multiply past the cap: the cap stops the walk and says so.
    const capped = data?.unknowns.filter((u) => u.plugin === "django" && (u.cause === "fan-out-capped" || u.cause === "budget")) ?? [];
    expect(capped.length).toBeGreaterThan(0);
    const registrations = data?.entities.filter((e) => e.kind === "registration").length ?? 0;
    expect(registrations).toBeLessThanOrEqual(10_000);
  }, 120_000);
});
