// The Django and Rails plugins cache their facts beside the language facts
// under .openqodex/graph, read every file of their language, and feed the
// review packet and the brief. A string from the code is kept only where a
// plugin reads its value (a route path or pattern, a route name, a
// controller#action, a template name, a model, table or field name, a
// settings module), so a key written anywhere else (a setting's value, a
// route's defaults or constraints, a test request's query string, a tag's
// name, a URL's user) reaches no facts file, no packet and no brief. The
// routes are still built.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { describe, expect, it } from "vitest";
import { writePacket } from "../src/review/packet.js";
import { buildGraph, detectImpact, openStore, renderImpactBlock } from "../src/index.js";
import type { Registration } from "../src/index.js";
import { commitAll, makeHome, makeRepo, writeFiles } from "./helpers.js";

const S = `sk_live_${randomBytes(16).toString("hex")}`;

const files: Record<string, string> = {
  // Django
  "py/requirements.txt": "Django==5.0\n",
  "py/manage.py": 'import os\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
  "py/mysite/__init__.py": "",
  "py/mysite/settings.py": `SECRET_KEY = "${S}"\nINSTALLED_APPS = ["mysite", "${S}"]\nROOT_URLCONF = "mysite.urls"\nSTRIPE = {"key": "${S}"}\nTEMPLATE_NAME = "${S}"\n`,
  "py/mysite/urls.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n    path("pages/<int:pk>/", views.page, {"token": "${S}"}, name="page"),\n]\n`,
  "py/mysite/views.py": `from django.conf import settings\nfrom django.shortcuts import render\n\n\ndef page(request, pk, token=None):\n    return render(request, "mysite/page.html", {"key": getattr(settings, "${S}", None)})\n`,
  "py/mysite/models.py": `from django.db import models\n\n\nclass Key(models.Model):\n    value = models.CharField(max_length=64, default="${S}")\n`,
  "py/mysite/templatetags/__init__.py": "",
  "py/mysite/templatetags/tags.py": `from django import template\n\nregister = template.Library()\n\n\n@register.simple_tag(name="${S}")\ndef shown():\n    return ""\n`,
  "py/mysite/templates/mysite/page.html": "<p></p>\n",
  "py/mysite/migrations/__init__.py": "",
  "py/mysite/migrations/0001_initial.py": `from django.db import migrations, models\n\n\nclass Migration(migrations.Migration):\n    dependencies = [("auth", "${S}")]\n    operations = [migrations.CreateModel(name="Key", fields=[("value", models.CharField(default="${S}", max_length=64))])]\n`,
  "py/mysite/tests.py": `from django.test import TestCase\n\n\nclass PageTests(TestCase):\n    def test_page(self):\n        self.client.get("/pages/7/?token=${S}")\n        self.client.get("https://user:${S}@example.com/pages/8/#${S}")\n`,
  // Rails
  "rb/Gemfile": 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
  "rb/config/application.rb": 'module Shop\n  class Application < Rails::Application\n  end\nend\n',
  "rb/config/routes.rb": `Rails.application.routes.draw do\n  get "/items/:id", to: "items#show", defaults: { token: "${S}" }, constraints: { key: "${S}" }, as: "item"\n  get "/search?key=${S}", to: "items#search"\n  resources :orders, only: [:index], format: "${S}"\nend\n`,
  "rb/app/controllers/items_controller.rb": "class ItemsController < ApplicationController\n  def show\n    head :ok\n  end\n\n  def search\n    head :ok\n  end\nend\n",
  "rb/app/controllers/orders_controller.rb": "class OrdersController < ApplicationController\n  def index\n    head :ok\n  end\nend\n",
  "rb/config/initializers/stripe.rb": `Stripe.api_key = "${S}"\nRails.application.config.x.stripe_key = "${S}"\n`,
  "rb/spec/requests/items_spec.rb": `require "rails_helper"\n\nRSpec.describe ItemsController, type: :request do\n  it "shows" do\n    get "/items/7?token=${S}"\n    get "https://user:${S}@example.com/items/8"\n  end\nend\n`,
};

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// A key-shaped token where the plugins do read the value (a route path
// segment, a Rails `to:`, a test request path), and the same token behind
// a query with no "=", a fragment and percent-encoding.
const T = `sk_live_${randomBytes(16).toString("hex")}`;
const ENCODED = [...T].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
const read: Record<string, string> = {
  "py/requirements.txt": "Django==5.0\n",
  "py/manage.py": 'import os\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
  "py/mysite/__init__.py": "",
  "py/mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n',
  "py/mysite/urls.py": `from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n    path("hooks/${T}/", views.hook, name="hook"),\n    path("enc/${ENCODED}/", views.hook),\n]\n`,
  "py/mysite/views.py": "def hook(request):\n    return None\n",
  "py/mysite/tests.py": `from django.test import TestCase\n\n\nclass HookTests(TestCase):\n    def test_hook(self):\n        self.client.post("/hooks/${T}/")\n        self.client.get("/x/?${T}")\n        self.client.get("/x/#${T}")\n        self.client.get("/enc/${ENCODED}/")\n`,
  "rb/Gemfile": 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n',
  "rb/config/application.rb": "module Shop\n  class Application < Rails::Application\n  end\nend\n",
  "rb/config/routes.rb": `Rails.application.routes.draw do\n  post "/hooks/${T}", to: "hooks#create"\n  get "/pay", to: "${T}"\n  get "/pay2", to: "hooks#${T}"\n  get "/enc/${ENCODED}", to: "hooks#create"\nend\n`,
  "rb/app/controllers/hooks_controller.rb": "class HooksController < ApplicationController\n  def create\n    head :ok\n  end\nend\n",
  "rb/spec/requests/hooks_spec.rb": `require "rails_helper"\n\nRSpec.describe HooksController, type: :request do\n  it "takes a hook" do\n    post "/hooks/${T}"\n    get "/x?${T}"\n    get "/x#${T}"\n    get "/enc/${ENCODED}"\n  end\nend\n`,
};

describe("the Django and Rails plugins on a repository with a key written in many places", () => {
  it("copy a key inside a route path, a Rails to: or a test request into no facts file, no packet and no brief, and still resolve the route", async () => {
    const home = makeHome();
    const root = makeRepo(read);
    commitAll(root);
    writeFiles(root, {
      "py/mysite/views.py": "def hook(request):\n    return 1\n",
      "rb/app/controllers/hooks_controller.rb": (read["rb/app/controllers/hooks_controller.rb"] as string).replace("head :ok", "head :no_content"),
    });
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const graph = await buildGraph({ repoRoot: root, store: opened.store, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(graph, change);
    const packet = await writePacket({ root, repoRoot: root, graph, impact, baseSha: change.baseSha, secrets: [] });
    impact.packet = packet.dir;
    const brief = renderImpactBlock(impact);

    const holding = (dir: string) => walk(dir).filter((f) => { const t = readFileSync(f, "utf8"); return t.includes(T) || t.includes(ENCODED); }).map((f) => f.slice(root.length + 1));
    expect(holding(join(root, ".openqodex"))).toEqual([]);
    expect(brief.includes(T) || brief.includes(ENCODED)).toBe(false);

    // The routes still resolve: each is registered and bound to its handler.
    const at = (site: string) => (graph.frameworks?.entities ?? []).find((e): e is Registration => e.kind === "registration" && `${e.site.file}:${e.site.line}` === site);
    expect(at("py/mysite/urls.py:6")?.handler.status).toBe("bound");
    // The key is named by the hash of its run, so the route still matches the request that names the same key.
    expect(at("py/mysite/urls.py:6")?.pattern).toMatch(/^hooks\/\[redacted:[0-9a-f]{8}\]\/$/);
    expect(at("rb/config/routes.rb:2")?.handler.status).toBe("bound");
    expect(at("rb/config/routes.rb:2")?.pattern).toMatch(/^\/hooks\/\[redacted:[0-9a-f]{8}\]$/);
    expect(brief).toMatch(/hooks\/\[redacted:[0-9a-f]{8}\]\//);
  }, 120_000);

  it("copy the key into no facts file, no packet and no brief, and still build the routes", async () => {
    const home = makeHome();
    const root = makeRepo(files);
    commitAll(root);
    // A change to each handler, in files that hold no key.
    writeFiles(root, {
      "py/mysite/views.py": (files["py/mysite/views.py"] as string).replace("def page(request, pk, token=None):\n", "def page(request, pk, token=None):\n    pk = int(pk)\n"),
      "rb/app/controllers/items_controller.rb": (files["rb/app/controllers/items_controller.rb"] as string).replace("head :ok\n  end\n\n  def search", "head :no_content\n  end\n\n  def search"),
    });
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    const change = await getChange({ repoRoot: root, scope: { uncommitted: true }, exclude: [] });
    const graph = await buildGraph({ repoRoot: root, store: opened.store, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    const impact = detectImpact(graph, change);
    const packet = await writePacket({ root, repoRoot: root, graph, impact, baseSha: change.baseSha, secrets: [] });
    impact.packet = packet.dir;
    const brief = renderImpactBlock(impact);

    const holding = (dir: string) => walk(dir).filter((f) => readFileSync(f, "utf8").includes(S)).map((f) => f.slice(root.length + 1));
    expect(holding(join(root, ".openqodex"))).toEqual([]);
    expect(brief.includes(S)).toBe(false);

    const patterns = (plugin: string) =>
      (graph.frameworks?.entities ?? [])
        .filter((e): e is Registration => e.kind === "registration" && e.plugin === plugin)
        .map((r) => r.pattern)
        .sort();
    expect(patterns("django")).toEqual(["pages/<int:pk>/"]);
    expect(patterns("rails")).toEqual(["/items/:id", "/orders", "/search"]);
    expect(brief).toContain("pages/<int:pk>/");
  }, 120_000);
});
