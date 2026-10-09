// A key written in a repository's code never travels through the framework
// plugins into the graph's files or the review. The plugins read every file
// of their language and keep their facts under .openqodex/graph, and a kept
// build holds what they found (index/frameworks.json); gitleaks reads only
// the change, so a key in a file the change does not touch is redacted by
// nothing. Each plugin's fixture plants the same key-shaped literal where a
// stranger's code puts one: an argument to a middleware call, a FastAPI
// dependency's argument, a Go wrapper's argument, a component's prop, a
// module constant. `review --agent` must keep the key in no facts file, no
// file of the review's run folder (the brief and the impact summary among
// them) and no line it prints, while the facts still hold the route paths.
// A kept build's framework data (index/frameworks.json, written only for a
// build over the five-second line) and the packet a reviewer reads are
// checked in packages/graph/src/frameworks/secrets.test.ts.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";
import { git, run } from "./support.js";

afterAll(removeTempDirs);

const KEY = `sk_live_${randomBytes(16).toString("hex")}`;

const base: Record<string, string> = {
  "js/package.json": JSON.stringify({ name: "js", private: true, type: "module", dependencies: { express: "^4.21.2" } }),
  "js/src/auth.js": "export function auth(key) {\n  return (req, res, next) => next();\n}\n",
  "js/src/h.js": 'export function h(req, res) {\n  res.end("ok");\n}\n',
  "js/src/server.js": `import express from "express";\nimport { auth } from "./auth.js";\nimport { h } from "./h.js";\n\nconst KEY = "${KEY}";\nconst app = express();\napp.use(auth("${KEY}"));\napp.get("/x", auth(KEY), h);\nexport default app;\n`,
  "py/pyproject.toml": '[project]\nname = "py"\nversion = "0.1.0"\ndependencies = ["fastapi>=0.115"]\n',
  "py/app/__init__.py": "",
  "py/app/handlers.py": "def read_items():\n    return []\n",
  "py/app/main.py": `from fastapi import Depends, FastAPI\n\nfrom app.handlers import read_items\n\nTOKEN = "${KEY}"\napp = FastAPI()\n\n\ndef verify(token):\n    return token\n\n\napp.add_api_route("/items", read_items, dependencies=[Depends(verify("${KEY}"))])\n`,
  "go/go.mod": "module example.com/svc\n\ngo 1.22\n",
  "go/handlers.go": "package main\n\nimport \"net/http\"\n\nfunc Items(w http.ResponseWriter, r *http.Request) {}\n",
  "go/main.go": `package main\n\nimport "net/http"\n\nconst apiKey = "${KEY}"\n\nfunc auth(key string, h http.Handler) http.Handler {\n\treturn h\n}\n\nfunc main() {\n\tmux := http.NewServeMux()\n\tmux.Handle("/items", auth("${KEY}", http.HandlerFunc(Items)))\n\thttp.ListenAndServe(":8080", mux)\n}\n`,
  "web/package.json": JSON.stringify({ name: "web", private: true, dependencies: { next: "^15.1.6", react: "^19.0.0" } }),
  "web/components/Card.tsx": "export function Card(props: { k: string }) {\n  return <div>{props.k.length}</div>;\n}\n",
  "web/app/page.tsx": `import { Card } from "../components/Card";\n\nconst KEY = "${KEY}";\n\nexport default function Page() {\n  return <Card k="${KEY}" />;\n}\n`,
};
// The change touches only files that hold no key.
const change: Record<string, string> = {
  "js/src/h.js": 'export function h(req, res) {\n  res.end("changed");\n}\n',
  "py/app/handlers.py": "def read_items():\n    return [1]\n",
  "go/handlers.go": "package main\n\nimport \"net/http\"\n\nfunc Items(w http.ResponseWriter, r *http.Request) {\n\tw.WriteHeader(204)\n}\n",
  "web/components/Card.tsx": "export function Card(props: { k: string }) {\n  return <span>{props.k.length}</span>;\n}\n",
};

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const holding = (list: string[]) => list.filter((f) => readFileSync(f).includes(KEY));

describe("a key in the code and the framework plugins", () => {
  it("keeps the key in no facts file, no file of the review and nothing the review prints", () => {
    const dir = tempDir("oq-fw-key-");
    const tools = tempDir("oq-fw-key-tools-");
    const write = (set: Record<string, string>) => {
      for (const [path, content] of Object.entries(set)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
    };
    write(base);
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "Base");
    write(change);
    const r = run("framework-key", dir, ["review", "--agent", "--only", "gitleaks", "--no-install", "--offline"], { tools });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("## What this change reaches");
    expect(r.stdout.includes(KEY) || r.stderr.includes(KEY)).toBe(false);
    // The repository's own folder: the facts, the build, the review's run folder.
    const store = files(join(dir, ".openqodex"));
    expect(store.some((f) => f.includes("/graph/facts/") && readFileSync(f, "utf8").includes('"/items"')), "no facts file holds the plugins' route paths").toBe(true);
    expect(store.some((f) => f.endsWith("brief.md")), "the review wrote no brief").toBe(true);
    expect(holding(store).map((f) => f.slice(dir.length + 1))).toEqual([]);
    // What the run kept outside the repository.
    expect(holding(files(tools)).map((f) => f.slice(tools.length + 1))).toEqual([]);
  });
});
