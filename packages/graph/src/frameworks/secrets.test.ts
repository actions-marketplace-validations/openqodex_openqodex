// The framework plugins cache their facts beside the language facts under
// .openqodex/graph, and every plugin reads every file of its language. A
// string literal is kept in those facts only where a plugin reads it (a
// route path, a prefix, a method, a request target's path, a constant one
// of those names), so a secret written anywhere else in the code, such as
// an API key, a client's argument, a header, a URL's user or query, a
// decorator's argument or a test's title, is never copied into the graph
// folder. The constants the routes are built from still resolve.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildGraph, openStore } from "../index.js";
import type { Graph, Registration } from "../index.js";

const S = `sk_live_${randomBytes(16).toString("hex")}`;

const files: Record<string, string> = {
  "py/pyproject.toml": '[project]\nname = "py"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n',
  "py/app/__init__.py": "",
  "py/app/main.py": `import os

import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

app = FastAPI(title="${S}")
API_KEY = "${S}"
billing = Billing("${S}", region="eu")
TOKEN = os.environ.get("TOKEN", "${S}")
PREFIX = "/items"
URL = "https://user:${S}@api.example.com/items?key=${S}"


@app.get(PREFIX, summary="${S}")
def items():
    return []


@app.get("/guarded")
@guard("${S}")
def guarded():
    return 1


def notify():
    requests.post("https://hooks.example.com/x?key=${S}", headers={"Authorization": "${S}"})


def test_items():
    client = TestClient(app)
    client.get(URL)
`,
  "js/package.json": JSON.stringify({ name: "js", private: true, dependencies: { express: "^4.21.2", supertest: "^7.1.0" }, devDependencies: { vitest: "^3.2.4" } }),
  "js/src/server.js": `const express = require("express");
const API_KEY = "${S}";
const stripe = new Stripe("${S}");
const PATH = "/x";
const app = express();
app.use(basicAuth({ users: { admin: "${S}" } }));
app.get(PATH, (req, res) => res.send("${S}"));
axios.get("https://user:${S}@api.example.com/v1?key=${S}", { headers: { Authorization: "${S}" } });
module.exports = { app, key: "${S}" };
`,
  "js/src/server.test.js": `const request = require("supertest");
const { it } = require("vitest");
const { app } = require("./server.js");
it("${S}", async () => {
  await request(app).get("/x?token=${S}");
});
`,
  "go/go.mod": "module example.com/svc\n\ngo 1.22\n",
  "go/main.go": `package main

import "net/http"

const apiKey = "${S}"
const path = "/x"

var token = "${S}"

func h(w http.ResponseWriter, r *http.Request) {}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc(path, h)
	mux.Handle("/y", auth("${S}", http.HandlerFunc(h)))
	req, _ := http.NewRequest("GET", "https://user:${S}@api.example.com/v1?key=${S}", nil)
	_ = req
	http.ListenAndServe(":8080", mux)
}
`,
  "web/package.json": JSON.stringify({ name: "web", private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" }, devDependencies: { "@testing-library/react": "^16.0.0", vitest: "^3.2.4" } }),
  "web/app/page.tsx": `const KEY = "${S}";\nexport default function Page() {\n  return <div data-key="${S}">{KEY}</div>;\n}\n`,
  "web/app/page.test.tsx": `import { render } from "@testing-library/react";\nimport { it } from "vitest";\nimport Page from "./page";\nit("${S}", () => {\n  render(<Page />);\n});\n`,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe("the framework plugins on a repository with a secret written in many places", () => {
  let root: string;
  let home: string;
  let graph: Graph;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oq-fw-secrets-"));
    home = mkdtempSync(join(tmpdir(), "oq-fw-secrets-home-"));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const opened = await openStore(root, { home });
    if (!opened.ok) throw new Error(opened.reason);
    graph = await buildGraph({ repoRoot: root, store: opened.store });
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("copies the secret into no file of the graph folder", () => {
    // Each file that holds it, with the JSON paths that hold it, so a failure names the fact.
    const holding = (o: unknown, at: string, out: string[]): string[] => {
      if (typeof o === "string" && o.includes(S)) out.push(at || "(the whole file)");
      else if (Array.isArray(o)) o.forEach((x, i) => holding(x, `${at}[${i}]`, out));
      else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) holding(v, `${at}.${k}`, out);
      return out;
    };
    const leaks = walk(join(root, ".openqodex"))
      .map((f) => ({ f, text: readFileSync(f, "utf8") }))
      .filter((x) => x.text.includes(S))
      .map((x) => {
        let parsed: unknown = x.text;
        try {
          parsed = JSON.parse(x.text);
        } catch {
          // Not JSON: the file as a whole.
        }
        return `${x.f.slice(root.length + 1)}: ${holding(parsed, "", []).join(" ")}`;
      });
    expect(leaks).toEqual([]);
  });

  it("still builds each route from the constant its path names", () => {
    const patterns = (plugin: string) =>
      (graph.frameworks?.entities ?? [])
        .filter((e): e is Registration => e.kind === "registration" && e.plugin === plugin)
        .map((r) => r.pattern)
        .sort();
    expect(patterns("fastapi")).toEqual(["/guarded", "/items"]);
    expect(patterns("express")).toEqual(["/x"]);
    expect(patterns("go-http")).toEqual(["/x", "/y"]);
  });
});
