// The Django plugin on a small real application and on hostile input.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { describe, expect, it } from "vitest";
import { PACKET_DIR, writePacket } from "../src/review/packet.js";
import { buildGraph, detectImpact, frameworkLayer, openStore, renderImpactBlock } from "../src/index.js";
import type { Graph, Registration } from "../src/index.js";
import { django } from "../src/frameworks/django/index.js";
import { parserFor } from "../src/parser.js";
import { commitAll, git, makeHome, makeRepo, symbol, writeFiles } from "./helpers.js";

const MiB = 1024 * 1024;
const home = makeHome();

// A small blog: a project urls module including the app's, function and
// class views, templates, models with a relation and two migrations, a
// management command, a signal receiver, a template tag, a settings key
// read in code, and tests that call, request and name routes.
const APP: Record<string, string> = {
  "requirements.txt": "Django==5.0\n",
  "manage.py": 'import os\n\nif __name__ == "__main__":\n    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
  "mysite/__init__.py": "",
  "mysite/settings.py": 'INSTALLED_APPS = ["blog"]\nROOT_URLCONF = "mysite.urls"\nPAGE_SIZE = 20\n',
  "mysite/urls.py": 'from django.urls import include, path\n\nurlpatterns = [\n    path("blog/", include("blog.urls")),\n]\n',
  "blog/__init__.py": "",
  "blog/urls.py": 'from django.urls import path\n\nfrom blog import views\n\napp_name = "blog"\nurlpatterns = [\n    path("", views.PostList.as_view(), name="list"),\n    path("<int:pk>/", views.detail, name="detail"),\n]\n',
  "blog/views.py":
    'from django.conf import settings\nfrom django.shortcuts import get_object_or_404, render\nfrom django.views.generic import ListView\n\nfrom blog.models import Post\n\n\ndef load(pk):\n    return get_object_or_404(Post, pk=pk)\n\n\ndef detail(request, pk):\n    post = load(pk)\n    return render(request, "blog/detail.html", {"post": post, "size": settings.PAGE_SIZE})\n\n\nclass PostList(ListView):\n    template_name = "blog/list.html"\n\n    def get(self, request):\n        return None\n\n\ndef about(request):\n    return render(request, "blog/about.html")\n',
  "blog/models.py": 'from django.db import models\n\n\nclass Author(models.Model):\n    name = models.CharField(max_length=80)\n\n\nclass Post(models.Model):\n    title = models.CharField(max_length=200)\n    author = models.ForeignKey(Author, on_delete=models.CASCADE)\n',
  "blog/migrations/__init__.py": "",
  "blog/migrations/0001_initial.py": 'from django.db import migrations, models\n\n\nclass Migration(migrations.Migration):\n    dependencies = []\n    operations = [\n        migrations.CreateModel(name="Author", fields=[]),\n        migrations.CreateModel(name="Post", fields=[]),\n    ]\n',
  "blog/migrations/0002_post_title.py": 'from django.db import migrations, models\n\n\nclass Migration(migrations.Migration):\n    dependencies = [("blog", "0001_initial")]\n    operations = [\n        migrations.AddField(model_name="post", name="title", field=models.CharField(max_length=200)),\n    ]\n',
  "blog/management/__init__.py": "",
  "blog/management/commands/__init__.py": "",
  "blog/management/commands/reindex.py": 'from django.core.management.base import BaseCommand\n\nfrom blog.views import load\n\n\nclass Command(BaseCommand):\n    def handle(self, *args, **options):\n        load(1)\n',
  "blog/signals.py": 'from django.db.models.signals import post_save\nfrom django.dispatch import receiver\n\nfrom blog.models import Post\n\n\n@receiver(post_save, sender=Post)\ndef on_post_saved(sender, instance, **kwargs):\n    return None\n',
  "blog/templatetags/__init__.py": "",
  "blog/templatetags/blog_tags.py": 'from django import template\n\nregister = template.Library()\n\n\n@register.inclusion_tag("blog/card.html")\ndef card(post):\n    return {"post": post}\n',
  "blog/templates/blog/detail.html": "<h1>{{ post.title }}</h1>\n",
  "blog/templates/blog/list.html": "<ul></ul>\n",
  "blog/templates/blog/card.html": "<div></div>\n",
  "blog/tests.py": 'from django.test import TestCase\nfrom django.urls import reverse\n\nfrom blog.views import load\n\n\nclass DetailTests(TestCase):\n    def test_request(self):\n        self.client.get("/blog/7/")\n\n    def test_named(self):\n        self.client.get(reverse("blog:list"))\n\n    def test_load(self):\n        load(7)\n',
};

async function storeOf(root: string) {
  const opened = await openStore(root, { home });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.store;
}

const registrationAt = (g: Graph, site: string): Registration | undefined => g.frameworks?.entities.find((e): e is Registration => e.kind === "registration" && `${e.site.file}:${e.site.line}` === site);

describe("the Django plugin on a small application", () => {
  it("answers which route maps to a view and its helper, and which tests reference, call or may request them", async () => {
    const root = makeRepo(APP);
    commitAll(root);
    const g = await buildGraph({ repoRoot: root, store: null });
    const layer = frameworkLayer(g);
    if (!layer) throw new Error("no framework layer");
    const load = symbol(g, "blog/views.py", "load");
    const routes = layer.routesReaching(load).routes;
    expect(routes.map((r) => [r.registration.pattern, r.registration.name, r.hops, r.tier])).toEqual([["blog/<int:pk>/", "blog:detail", 1, "certain"]]);
    const tests = layer.testsOf(load).map((t) => [t.test.replace(/@.*/, ""), t.category, t.tier]);
    expect(tests).toContainEqual(["blog/tests.py#DetailTests.test_load", "direct-call", "certain"]);
    expect(tests).toContainEqual(["blog/tests.py#DetailTests.test_request", "route-request", "likely"]);
    const list = registrationAt(g, "blog/urls.py:7");
    expect(list?.handler.status).toBe("bound");
    expect(layer.edgesTo(list?.id ?? "").some((e) => e.kind === "tests" && e.category === "route-name")).toBe(true);
  }, 60_000);

  it("links templates, models, migrations, the command, the signal receiver, the template tag and the settings key", async () => {
    const root = makeRepo(APP);
    commitAll(root);
    const g = await buildGraph({ repoRoot: root, store: null });
    const layer = frameworkLayer(g);
    if (!layer) throw new Error("no framework layer");
    const name = (id: string): string => {
      const e = layer.entity(id);
      return e && e.kind !== "registration" ? e.name : id.replace(/@.*/, "");
    };
    const edges = (kind: string, from: string) => layer.edgesFrom(from).filter((e) => e.kind === kind).map((e) => name(e.to));
    expect(edges("renders", symbol(g, "blog/views.py", "detail"))).toEqual(["blog/detail.html"]);
    expect(edges("renders", symbol(g, "blog/views.py", "PostList"))).toEqual(["blog/list.html"]);
    expect(edges("renders", symbol(g, "blog/templatetags/blog_tags.py", "card"))).toEqual(["blog/card.html"]);
    const post = symbol(g, "blog/models.py", "Post");
    expect(layer.edgesTo(post).filter((e) => e.kind === "changes_schema").map((e) => e.from).sort()).toEqual(["blog/migrations/0001_initial.py", "blog/migrations/0002_post_title.py"]);
    expect(edges("uses_type", post)).toEqual(["blog/models.py#Author"]);
    expect(edges("reads_config", symbol(g, "blog/views.py", "detail"))).toEqual(["PAGE_SIZE"]);
    const command = g.frameworks?.entities.find((e) => e.kind === "command");
    expect(command && command.kind !== "registration" ? command.name : null).toBe("reindex");
    expect(edges("runs", command?.id ?? "")).toEqual(["blog/management/commands/reindex.py#Command.handle"]);
    expect(layer.rolesOf(symbol(g, "blog/signals.py", "on_post_saved")).map((r) => r.role)).toContain("signal_receiver");
  }, 60_000);

  it("prints the route, the test links and no coverage claim for a helper change in the brief", async () => {
    const root = makeRepo(APP);
    commitAll(root);
    writeFiles(root, { "blog/views.py": (APP["blog/views.py"] as string).replace("return get_object_or_404(Post, pk=pk)", "return get_object_or_404(Post, pk=int(pk))") });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const brief = renderImpactBlock(detectImpact(g, change));
    expect(brief).toContain("| `ANY blog/<int:pk>/` | `blog:detail` | `blog/urls.py:8` | `views.detail` | reaches `load` in 1 hop (certain) |");
    expect(brief).toContain("| `DetailTests.test_load` | `blog/tests.py:15` | calls | `load` | certain |");
    expect(brief).toContain("| `DetailTests.test_request` | `blog/tests.py:9` | requests through route `ANY blog/<int:pk>/` | `load` | likely: ");
    expect(brief).not.toMatch(/\bcover(s|age:)/);
  }, 60_000);

  it("writes every route and test link past the brief's cut into the packet, and the brief names the file that holds them", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `    path("r${i}/", views.detail, name="r${i}"),\n`).join("");
    const files = { ...APP, "blog/urls.py": `from django.urls import path\n\nfrom blog import views\n\napp_name = "blog"\nurlpatterns = [\n${many}]\n` };
    const root = makeRepo(files);
    commitAll(root);
    writeFiles(root, { "blog/views.py": (APP["blog/views.py"] as string).replace("return get_object_or_404(Post, pk=pk)", "return get_object_or_404(Post, pk=str(pk))") });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    const packet = await writePacket({ root, repoRoot: root, graph: g, impact, baseSha: change.baseSha, secrets: [] });
    impact.packet = packet.dir;
    expect(packet.files).toContain("frameworks.json");
    const held = JSON.parse(readFileSync(join(root, PACKET_DIR, "frameworks.json"), "utf8")) as { routes: { pattern: string | null }[]; tests: unknown[] };
    expect(held.routes.map((r) => r.pattern).sort()).toEqual(Array.from({ length: 15 }, (_, i) => `blog/r${i}/`).sort());
    const brief = renderImpactBlock(impact);
    expect(brief).toContain(`| and 3 more, every one in \`${PACKET_DIR}/frameworks.json\` |`);
  }, 60_000);

  it("finds the routes of unchanged files once Django is added to the manifest, from cached facts, never from a stale build", async () => {
    const root = makeRepo({ ...APP, "requirements.txt": "requests==2.32\n" });
    commitAll(root);
    const store = await storeOf(root);
    const before = await buildGraph({ repoRoot: root, store });
    expect(before.frameworks?.apps).toEqual([]);
    expect(before.frameworks?.entities.filter((e) => e.kind === "registration")).toEqual([]);
    writeFiles(root, { "requirements.txt": "requests==2.32\nDjango==5.0\n" });
    git(root, "add", "-A");
    const after = await buildGraph({ repoRoot: root, store });
    // Every Python file's facts come from the cache: nothing was parsed again.
    expect(after.status.parses).toBe(0);
    expect(after.frameworks?.apps.length).toBe(1);
    expect(registrationAt(after, "blog/urls.py:8")?.handler.status).toBe("bound");
  }, 60_000);

  it("keeps the framework data in a retained index equal to the fresh build, and never reuses it once a template it names is added", async () => {
    const root = makeRepo(APP);
    commitAll(root);
    const store = await storeOf(root);
    const fresh = await buildGraph({ repoRoot: root, store, mode: "retained" });
    const loaded = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(loaded.status.parses).toBe(0);
    expect(loaded.status.generation).toBe(fresh.status.generation);
    expect(JSON.stringify(loaded.frameworks)).toBe(JSON.stringify(fresh.frameworks));
    const about = (g: Graph) => {
      const layer = frameworkLayer(g);
      const edge = layer?.edgesFrom(symbol(g, "blog/views.py", "about")).find((e) => e.kind === "renders");
      const t = edge ? layer?.entity(edge.to) : null;
      return t && t.kind !== "registration" ? t.file : "no edge";
    };
    expect(about(loaded)).toBeNull();
    // A template is not a source file: only the plugins' inputs name it.
    writeFiles(root, { "blog/templates/blog/about.html": "about\n" });
    git(root, "add", "-A");
    const next = await buildGraph({ repoRoot: root, store, mode: "retained" });
    expect(next.frameworks?.fingerprint).not.toBe(fresh.frameworks?.fingerprint);
    expect(about(next)).toBe("blog/templates/blog/about.html");
  }, 60_000);
});

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

  // A 600-route table under twenty prefixes: 12,000 registrations, past the
  // 10,000 one application keeps.
  const capped = {
    "requirements.txt": "Django==5.0\n",
    "mysite/__init__.py": "",
    "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n',
    "mysite/urls.py": `from django.urls import include, path\n\nurlpatterns = [\n${Array.from({ length: 20 }, (_, i) => `    path("p${i}/", include("mysite.table")),\n`).join("")}]\n`,
    "mysite/table.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 600 }, (_, i) => `    path("r${i}/", views.page),\n`).join("")}]\n`,
    "mysite/views.py": "def page(request):\n    return None\n",
  };

  it("says when an application's routes pass the registration cap, so the routes it leaves out are a gap, never silent", async () => {
    const root = makeRepo(capped);
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    const data = graph.frameworks;
    expect(data?.entities.filter((e) => e.kind === "registration").length).toBe(10_000);
    const gap = data?.unknowns.find((u) => u.plugin === "django" && u.cause === "fan-out-capped" && "app" in u.scope);
    expect(gap?.note).toContain("10000");
  }, 120_000);

  it("carries an application's gaps into the brief and the packet for a change in that application", async () => {
    const root = makeRepo(capped);
    commitAll(root);
    writeFiles(root, { "mysite/views.py": "def page(request):\n    return 1\n" });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    expect(impact.frameworks?.unknown.some((u) => u.cause === "fan-out-capped")).toBe(true);
    const packet = await writePacket({ root, repoRoot: root, graph: g, impact, baseSha: change.baseSha, secrets: [] });
    const held = JSON.parse(readFileSync(join(root, PACKET_DIR, "frameworks.json"), "utf8")) as { unknowns: { cause: string }[] };
    expect(held.unknowns.some((u) => u.cause === "fan-out-capped")).toBe(true);
    impact.packet = packet.dir;
    expect(renderImpactBlock(impact)).toMatch(/What the framework plugins could not see[\s\S]*fan-out-capped/);
  }, 120_000);

  it("writes every route a change declares into the packet when no handler changes, past the summary's forty", async () => {
    const root = makeRepo({ ...capped, "mysite/urls.py": 'from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = []\n' });
    commitAll(root);
    writeFiles(root, { "mysite/urls.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n${Array.from({ length: 50 }, (_, i) => `    path("n${i}/", views.page),\n`).join("")}]\n` });
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const g = await buildGraph({ repoRoot: root, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(g, change);
    expect(impact.touched).toEqual([]);
    expect(impact.frameworks?.routesTotal).toBe(50);
    await writePacket({ root, repoRoot: root, graph: g, impact, baseSha: change.baseSha, secrets: [] });
    const held = JSON.parse(readFileSync(join(root, PACKET_DIR, "frameworks.json"), "utf8")) as { routes: { pattern: string }[] };
    expect(held.routes.map((r) => r.pattern).sort()).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}/`).sort());
  }, 120_000);

  it("resolves a models module of 25,000 classes and one field, and settings reads nested deep, in under a second", async () => {
    const models = `from django.db import models\n\n\nclass First(models.Model):\n    f = models.IntegerField()\n${Array.from({ length: 25_000 }, (_, i) => `class M${i}(models.Model): pass\n`).join("")}`;
    const deep = `from django.conf import settings\n\n\ndef f():\n    return ${"(".repeat(200)}settings.KEY${")".repeat(200)}\n`;
    const reads = `from django.conf import settings\n\n\ndef g():\n${Array.from({ length: 5_000 }, (_, i) => `    x${i} = settings.KEY_${i % 50}\n`).join("")}`;
    const root = makeRepo({ "requirements.txt": "Django==5.0\n", "mysite/__init__.py": "", "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\nKEY = 1\n', "mysite/urls.py": "urlpatterns = []\n", "mysite/models.py": models, "mysite/deep.py": deep, "mysite/reads.py": reads });
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 2 * MiB, budgetMs: 120_000 });
    expect(graph.frameworks?.plugins.find((p) => p.id === "django")?.status).toBe("ok");
    expect(graph.frameworks?.roles.filter((r) => r.role === "model").length).toBe(25_001);
    expect(graph.status.stages.frameworks ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
  }, 120_000);
});
