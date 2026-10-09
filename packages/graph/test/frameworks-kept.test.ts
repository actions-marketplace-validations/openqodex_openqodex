// The one rule by which every framework plugin keeps a string from the code
// in its cached facts (src/frameworks/shared/kept.ts): a string is kept only
// where a plugin reads it, shaped to the form the plugin reads, applied to
// the whole value it reads, bounded and with key-shaped text redacted; any
// other literal is an unread placeholder. A kept string that the rule
// altered is display text only: it never matches as if it were the value.
// Ways it could fail, written before the code:
//  1. A concatenation is kept piece by piece, so pieces that each pass the
//     rule rebuild a key ("/sk_" + "live_..."), and the later pieces of an
//     absolute URL ("https://" + "user:secret@host", ".../bot" + secret)
//     are copied although the URL's own rule would drop them.
//  2. A request target keeps a query with no "=" in it ("/x?secret").
//  3. Two paths longer than the bound match on the prefix they keep, and a
//     key-shaped template name, once redacted, no longer finds its file.
//  4. A known key prefix inside a run ("customer_ghp_...") is not found.
//  5. A literal the plugin never reads is copied: an object's key, a
//     decorator's nested argument, a lookup on a plain dictionary.
//  6. A constant is kept by its name alone, so a function's local of the
//     same name is copied with the module constant a route reads.
//  7. A requirements file that includes a URL with credentials copies them
//     into the gap that says the include is not read.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { buildGraph, openStore } from "../src/index.js";
import type { Graph, Registration } from "../src/index.js";
import { commitAll, makeHome, makeRepo } from "./helpers.js";

// A secret no key shape catches: only where it is kept can protect it.
const N = ["hunter2", "open", "sesame"].join("-");
const SPLIT = "Zx9Yw8Vu7Ts6Rq5P";
const PREFIXED = `ghp_${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"}abcdefghi`;
const TEMPLATE = `sk_live_${"Q1w2E3r4T5y6U7i8"}`;
const LONG = "a".repeat(600);

const files: Record<string, string> = {
  "js/package.json": JSON.stringify({ name: "js", private: true, type: "module", dependencies: { express: "^4.21.2", axios: "^1.7.0", supertest: "^7.1.0" }, devDependencies: { vitest: "^3.2.4" } }),
  "js/src/server.js": `import express from "express";
import axios from "axios";

export const app = express();
const VERSION = "v1";
function h(req, res) {
  res.end();
}
app.get("/sk_" + "live_" + "${SPLIT}", h);
app.get("/customer_${PREFIXED}", h);
app.get("/${LONG}x", h);
app.get("/" + VERSION + "/users", h);
const headers = { "${N}": "unused" };
axios.get("https://" + "user:${N}@host/x");
axios.get("https://api.example.com/bot" + "${N}" + "/getMe");
function local() {
  const VERSION = "${N}";
  return VERSION;
}
export const extra = { headers, local };
`,
  "js/src/server.test.js": `import request from "supertest";
import { it } from "vitest";
import { app } from "./server.js";
it("requests", async () => {
  await request(app).get("/x?${N}");
  await request(app).get("/${LONG}y");
  await request(app).get("/v1/users");
});
`,
  "py/pyproject.toml": '[project]\nname = "py"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n',
  "py/app/__init__.py": "",
  "py/app/main.py": `from fastapi import FastAPI
from fastapi.testclient import TestClient

app = FastAPI()
VERSION = "v1"
lookup = {}


def factory(x):
    return lambda: (lambda f: f)


@app.get("/x")
@factory("${N}")()
def x():
    return 1


@app.get("/" + VERSION + "/users")
def users():
    return []


def other():
    VERSION = "${N}"
    return VERSION


def lookups():
    return lookup.get("${N}")


def test_x():
    client = TestClient(app)
    client.get("/x?${N}")
`,
  "go/go.mod": "module example.com/svc\n\ngo 1.22\n",
  "go/main.go": `package main

import "net/http"
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

func h(w http.ResponseWriter, r *http.Request) {}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/x", h)
	req, _ := http.NewRequest("GET", "https://api.example.com/bot"+"${N}"+"/getMe", nil)
	_ = req
	http.ListenAndServe(":8080", mux)
}
`,
  "dj/requirements.txt": `Django==5.0\n-r https://alice:${N}@example.com/private.txt\n`,
  "dj/manage.py": 'import os\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")\n',
  "dj/mysite/__init__.py": "",
  "dj/mysite/settings.py": 'INSTALLED_APPS = ["mysite"]\nROOT_URLCONF = "mysite.urls"\n',
  "dj/mysite/urls.py": 'from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [\n    path("t/", views.t, name="t"),\n]\n',
  "dj/mysite/views.py": `from django.shortcuts import render\n\n\ndef t(request):\n    return render(request, "${TEMPLATE}.html")\n`,
  [`dj/mysite/templates/${TEMPLATE}.html`]: "<p></p>\n",
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

describe("the one rule every framework plugin keeps a string by", () => {
  let root: string;
  let home: string;
  let graph: Graph;
  beforeAll(async () => {
    root = makeRepo(files);
    home = makeHome();
    commitAll(root);
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    // Kept with its index, so the framework data is written to the graph folder too.
    graph = await buildGraph({ repoRoot: root, store: opened.store, mode: "retained" });
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // Each file of the graph folder that holds the text, with the JSON paths that hold it.
  const holding = (needle: string): string[] => {
    const at = (o: unknown, path: string, out: string[]): string[] => {
      if (typeof o === "string" && o.includes(needle)) out.push(path || "(the file)");
      else if (Array.isArray(o)) o.forEach((x, i) => at(x, `${path}[${i}]`, out));
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) at(k.includes(needle) ? k : v, `${path}.${k}`, out);
      return out;
    };
    return walk(join(root, ".openqodex"))
      .map((f) => ({ f, text: readFileSync(f, "utf8") }))
      .filter((x) => x.text.includes(needle))
      .map((x) => {
        let parsed: unknown = x.text;
        try {
          parsed = JSON.parse(x.text);
        } catch {
          // Not JSON: the file as a whole.
        }
        return `${x.f.slice(root.length + 1)}: ${at(parsed, "", []).slice(0, 4).join(" ")}`;
      });
  };

  it("copies no literal a plugin does not read, and no part of a URL past its path (1, 2, 5, 6, 7)", () => {
    expect(holding(N)).toEqual([]);
  });

  it("keeps no key that pieces of a concatenation assemble, nor one behind a prefix inside a run (1, 4)", () => {
    expect(holding(SPLIT)).toEqual([]);
    expect(holding(PREFIXED)).toEqual([]);
  });

  it("still builds the routes a module constant names, and only from the constant the route reads (6)", () => {
    const patterns = (plugin: string) =>
      (graph.frameworks?.entities ?? [])
        .filter((e): e is Registration => e.kind === "registration" && e.plugin === plugin)
        .map((r) => r.pattern)
        .filter((p): p is string => p !== null && p.includes("users"));
    expect(patterns("express")).toEqual(["/v1/users"]);
    expect(patterns("fastapi")).toEqual(["/v1/users"]);
  });

  it("never links a request to a route whose path only shares the part a bound keeps (3)", () => {
    const lineOf = (text: string) => (files["js/src/server.test.js"] as string).split("\n").findIndex((l) => l.includes(text)) + 1;
    const linksAt = (line: number) => (graph.frameworks?.edges ?? []).filter((e) => e.kind === "tests" && e.evidence.site.file === "js/src/server.test.js" && e.evidence.site.line === line);
    // The same test's request of a short path is linked, so the long one is not left out for another reason.
    expect(linksAt(lineOf('"/v1/users"')).length).toBeGreaterThan(0);
    expect(linksAt(lineOf(`${LONG}y`))).toEqual([]);
  });

  it("finds the template a key-shaped name names, though the name it keeps is redacted (3)", () => {
    const templates = (graph.frameworks?.entities ?? []).filter((e) => e.kind === "template" && e.plugin === "django");
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) expect(t.kind === "template" && "detail" in t ? t.detail : null).not.toBe("missing");
    expect(templates.some((t) => "file" in t && t.file === `dj/mysite/templates/${TEMPLATE}.html`)).toBe(true);
  });
});
