// Every cut, cap, budget stop and gap of the framework layer reaches what
// the reviewer reads, with its cause: the summary, the brief and the packet
// for a change, and the floor of a question. Ways it could fail, written
// before the code:
//  1. A gap the stage records with no relation named (a file's facts past
//     the per-file cap, facts it could not read) is taken by the questions
//     as hiding nothing, so `routes` answers a short list as whole.
//  2. A gap that carries a site is shown only when that file changed, so an
//     application's gap at an unchanged mount or settings file disappears
//     though the route the change reaches rests on it.
//  3. The framework summary keeps the routes of the first 25 touched
//     symbols, and a route walk stops at its visit cap, and neither says so.
//  4. `graph impact` lists the uses of a touched symbol the summary kept,
//     at most 200 of each kind, as if whole.
//  5. The Django plugin cuts a field's base chain, the test links of a
//     request that matches more routes than it keeps, or its work budget
//     inside the last request, and records nothing.
//  6. The packet's unknowns hold the graph's gaps and none of the
//     framework layer's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import type { Change, ImpactSummary } from "@openqodex/core";
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { buildGraph, detectImpact } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { query } from "../src/query/engine.js";
import type { Item, Request } from "../src/query/engine.js";
import { writePacket } from "../src/review/packet.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A repository committed, then changed: its graph, change and summary.
async function changed(base: Record<string, string>, edits: Record<string, string>): Promise<{ root: string; graph: Graph; change: Change; impact: ImpactSummary }> {
  const root = makeRepo(base);
  dirs.push(root);
  commitAll(root);
  writeFiles(root, edits);
  const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
  const graph = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
  return { root, graph, change, impact: detectImpact(graph, change) };
}

const EXPRESS_PKG = JSON.stringify({ name: "js", private: true, type: "module", dependencies: { express: "^4.21.2" } });

describe("the gaps of the framework layer", () => {
  it("answers routes as a floor when a file's facts passed the per-file cap (1)", async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `app.get("/r${i}", h);`).join("\n");
    const root = makeRepo({ "package.json": EXPRESS_PKG, "src/server.js": `import express from "express";\nexport const app = express();\nfunction h(req, res) {\n  res.end();\n}\n${lines}\n` });
    dirs.push(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    expect((graph.frameworks?.unknowns ?? []).some((u) => u.plugin === "express" && u.cause === "fan-out-capped" && u.scope && "file" in u.scope)).toBe(true);
    const a = query({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "routes", limit: 5 } as Request);
    expect(a.error).toBeNull();
    expect(a.unknown.floor).toBe(true);
    expect(a.unknown.reasons.join(" ")).toMatch(/kept the first facts/);
  }, 60_000);

  it("shows an application's gap at an unchanged mount for the route the change reaches, in the summary, the brief and the packet (2, 6)", async () => {
    const { root, graph, impact } = await changed(
      {
        "package.json": EXPRESS_PKG,
        "src/server.js": 'import express from "express";\nimport { router } from "./routes.js";\n\nexport const app = express();\napp.use(`/${process.env.PREFIX}`, router);\n',
        "src/routes.js": 'import { Router } from "express";\nimport { show } from "./h.js";\n\nexport const router = Router();\nrouter.get("/items", show);\n',
        "src/h.js": "export function show(req, res) {\n  res.end();\n}\n",
      },
      { "src/h.js": "export function show(req, res) {\n  res.end(\"x\");\n}\n" },
    );
    const fw = impact.frameworks;
    expect(fw?.routes.some((r) => r.reach !== null)).toBe(true);
    expect(fw?.unknown.some((u) => u.file === "src/server.js" && u.line === 5 && u.cause === "dynamic")).toBe(true);
    const packet = await writePacket({ root, repoRoot: root, graph, impact, baseSha: null, secrets: [] });
    const unknowns = JSON.parse(readFileSync(join(root, packet.dir, "unknowns.json"), "utf8")) as { items: { file: string; line: number | null; cause: string; plugin?: string }[] };
    expect(unknowns.items.some((u) => u.plugin === "express" && u.file === "src/server.js" && u.line === 5 && u.cause === "dynamic")).toBe(true);
    const framework = JSON.parse(readFileSync(join(root, packet.dir, "frameworks.json"), "utf8")) as { unknowns: { site: { file: string; line: number } | null; cause: string }[] };
    expect(framework.unknowns.some((u) => u.site?.file === "src/server.js" && u.site.line === 5)).toBe(true);
  }, 60_000);

  it("shows a Django application's computed root URLconf for a change to a view alone (2)", async () => {
    const { impact } = await changed(
      {
        "requirements.txt": "Django==5.0\n",
        "manage.py": 'import os\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
        "mysite/__init__.py": "",
        "mysite/settings.py": 'import os\n\nINSTALLED_APPS = ["mysite"]\nROOT_URLCONF = os.environ["URLS"]\n',
        "mysite/urls.py": 'from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [path("a/", views.a)]\n',
        "mysite/views.py": "def a(request):\n    return None\n",
      },
      { "mysite/views.py": "def a(request):\n    return 1\n" },
    );
    expect(impact.frameworks?.unknown.some((u) => u.file === "mysite/settings.py" && u.cause === "dynamic")).toBe(true);
  }, 60_000);

  it("says when the framework summary keeps the first touched symbols only (3)", async () => {
    const fns = Array.from({ length: 30 }, (_, i) => `export function f${i}() {\n  return ${i};\n}\n`).join("\n");
    const { impact } = await changed(
      {
        "package.json": EXPRESS_PKG,
        "src/server.js": 'import express from "express";\nexport const app = express();\napp.get("/x", (req, res) => res.end());\n',
        "src/many.js": fns,
      },
      { "src/many.js": fns.replaceAll("return", "return 1 +") },
    );
    const notes = (impact.frameworks?.unknown ?? []).map((u) => `${u.cause}: ${u.note}`).join("\n");
    expect(notes).toMatch(/fan-out-capped: the change touches 30 symbols; the framework entries of the first 25/);
  }, 60_000);

  it("says when a route walk from a touched symbol stopped at its cap (3)", async () => {
    const callers = Array.from({ length: 2100 }, (_, i) => `export function c${i}() {\n  return t();\n}\n`).join("\n");
    const { impact } = await changed(
      {
        "package.json": EXPRESS_PKG,
        "src/server.js": 'import express from "express";\nexport const app = express();\napp.get("/x", (req, res) => res.end());\n',
        "src/t.js": "export function t() {\n  return 0;\n}\n",
        "src/callers.js": `import { t } from "./t.js";\n${callers}`,
      },
      { "src/t.js": "export function t() {\n  return 1;\n}\n" },
    );
    const notes = (impact.frameworks?.unknown ?? []).map((u) => `${u.cause}: ${u.note}`).join("\n");
    expect(notes).toMatch(/the walk from t to the routes that reach it stopped after 2000/);
  }, 60_000);

  it("lists every use of a touched symbol in graph impact, past the 200 the summary keeps (4)", async () => {
    // 201 functions, each using handler as a value once: 201 distinct uses.
    const uses = Array.from({ length: 201 }, (_, i) => `export function u${i}(): unknown[] {\n  return [handler];\n}`).join("\n");
    const root = makeRepo({ "src/h.ts": "export function handler(): number {\n  return 1;\n}\n", "src/uses.ts": `import { handler } from "./h";\n${uses}\n` });
    dirs.push(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const a = query({ graph, generation: "g", treeSha: null, builtAt: null, laterEditsKnown: false }, { apiVersion: 1, kind: "impact", target: { name: "handler" }, limit: 500 } as Request);
    expect(a.error).toBeNull();
    const refs = (a.items as { type: string; hops: Item[] }[]).filter((x) => x.type === "reference");
    expect(refs.length).toBe(201);
  }, 60_000);

  it("records a Django field base chain past its depth, and a request that matches more routes than it links (5)", async () => {
    const chain = ["class F0(models.IntegerField):\n    pass\n", ...Array.from({ length: 8 }, (_, i) => `class F${i + 1}(F${i}):\n    pass\n`)].join("\n\n");
    const routes = Array.from({ length: 33 }, (_, i) => `    path("<int:pk>/", views.v${i}),`).join("\n");
    const views = Array.from({ length: 33 }, (_, i) => `def v${i}(request, pk):\n    return None\n`).join("\n\n");
    const root = makeRepo({
      "requirements.txt": "Django==5.0\n",
      "manage.py": 'import os\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
      "mysite/__init__.py": "",
      "mysite/settings.py": 'INSTALLED_APPS = ["mysite"]\nROOT_URLCONF = "mysite.urls"\n',
      "mysite/urls.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${routes}\n]\n`,
      "mysite/views.py": views,
      "mysite/models.py": `from django.db import models\n\n\n${chain}\n\nclass Thing(models.Model):\n    value = F8()\n`,
      "mysite/tests.py": 'from django.test import TestCase\n\n\nclass T(TestCase):\n    def test_it(self):\n        self.client.get("/5/")\n',
    });
    dirs.push(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const gaps = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "django");
    expect(gaps.some((u) => u.cause === "fan-out-capped" && u.affects.includes("declares_field") && u.site?.file === "mysite/models.py")).toBe(true);
    expect(gaps.some((u) => u.cause === "fan-out-capped" && u.affects.includes("tests") && u.count === 1 && u.site?.file === "mysite/tests.py")).toBe(true);
  }, 60_000);

  it("records the work budget a Django test request used up, though no request follows it (5)", async () => {
    const modules: Record<string, string> = {};
    const includes: string[] = [];
    for (let m = 0; m < 4; m++) {
      const entries = Array.from({ length: 1500 }, (_, i) => `    path("<path:p>x${i}/", views.v),`).join("\n");
      modules[`mysite/u${m}.py`] = `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${entries}\n]\n`;
      includes.push(`    path("", include("mysite.u${m}")),`);
    }
    const root = makeRepo({
      "requirements.txt": "Django==5.0\n",
      "manage.py": 'import os\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
      "mysite/__init__.py": "",
      "mysite/settings.py": 'INSTALLED_APPS = ["mysite"]\nROOT_URLCONF = "mysite.urls"\n',
      "mysite/urls.py": `from django.urls import include, path\n\nurlpatterns = [\n${includes.join("\n")}\n]\n`,
      "mysite/views.py": "def v(request, p):\n    return None\n",
      "mysite/tests.py": `from django.test import TestCase\n\n\nclass T(TestCase):\n    def test_it(self):\n        self.client.get("/${"a".repeat(400)}!")\n`,
      ...modules,
    });
    dirs.push(root);
    const graph = await buildGraph({ repoRoot: root, store: null, budgetMs: 120_000 });
    const gaps = (graph.frameworks?.unknowns ?? []).filter((u) => u.plugin === "django" && u.cause === "budget");
    expect(gaps.length).toBeGreaterThan(0);
  }, 120_000);
});
