// Python requirements files that include others (issue #70). pip reads
// `-r file` and `-c file` relative to the including file, and many
// projects keep their dependencies in `requirements/*.txt` or pip-tools
// `*.in` files that a root requirements.txt includes, or that nothing at the
// root names at all. Ways the project model could fail, one test each:
// 1. An included file is never read, so a dependency it declares (Django)
//    reads as undeclared and the framework is never detected.
// 2. A requirements file under a `requirements/` folder, or a pip-tools
//    `.in` file, is not read because its name does not start with
//    "requirements".
// 3. An include that points outside the repository is read, or dropped
//    without a word.
// 4. A chain or a cycle of includes is followed without a bound.
// 5. An include past the byte cap is read in full.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph } from "../src/index.js";
import { discoverProjects } from "../src/discovery/projects.js";
import { MANIFEST_BYTES } from "../src/discovery/manifests.js";
import { RepoReader } from "../src/safe-fs.js";
import { commitAll, makeRepo } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

// Every folder the shared helpers made for this file goes when it ends (tests/temp-guard.ts).
afterAll(removeTempDirs);

function model(files: Record<string, string>) {
  const root = makeRepo(files);
  return discoverProjects(Object.keys(files), new RepoReader(root));
}

describe("requirements files that include others", () => {
  it("declares what a requirements file included with -r declares, relative to the including file (1)", () => {
    const m = model({ "requirements.txt": "-r requirements/production.txt\n", "requirements/production.txt": "-r base.txt\ngunicorn==22.0\n", "requirements/base.txt": "Django>=5.0,<5.1\n" });
    expect(m.pyDeclared.has("django")).toBe(true);
    expect(m.pyDeclared.has("gunicorn")).toBe(true);
  });

  it("follows -c, --requirement and --constraint, with or without an equals sign (1)", () => {
    const m = model({ "requirements.txt": "--requirement=dev.txt\n-c constraints.txt\n", "dev.txt": "--constraint pins.txt\npytest\n", "constraints.txt": "celery==5.4\n", "pins.txt": "redis==5.0\n" });
    for (const name of ["pytest", "celery", "redis"]) expect(m.pyDeclared.has(name), name).toBe(true);
  });

  it("reads a pip-tools layout under requirements/ that no root file names (2)", () => {
    const m = model({
      "requirements/base.in": "Django\ndjango-environ\n",
      "requirements/base.txt": "django==5.0.6\n    # via -r requirements/base.in\ndjango-environ==0.11.2\n",
      "requirements/dev.in": "-c base.txt\n-r base.in\npytest-django\n",
      "requirements/dev.txt": "pytest-django==4.8.0\n",
    });
    for (const name of ["django", "django_environ", "pytest_django"]) expect(m.pyDeclared.has(name), name).toBe(true);
  });

  it("never reads an include outside the repository, and says so as a gap (3)", () => {
    const m = model({ "requirements.txt": "-r ../../outside/requirements.txt\n-r /etc/hosts\n-r https://example.com/r.txt\nflask\n" });
    expect(m.pyDeclared.has("flask")).toBe(true);
    const notes = m.unreadable.filter((g) => g.file === "requirements.txt").map((g) => g.note);
    expect(notes.filter((n) => n.includes("outside the repository")).length).toBe(3);
  });

  it("stops a chain of includes at its bound with a gap, and a cycle at once (4)", () => {
    const files: Record<string, string> = { "requirements.txt": "-r r0.txt\n-r requirements.txt\n" };
    for (let i = 0; i < 80; i++) files[`r${i}.txt`] = `-r r${i + 1}.txt\npkg${i}\n`;
    files["r80.txt"] = "last\n";
    const m = model(files);
    expect(m.pyDeclared.has("pkg0")).toBe(true);
    expect(m.pyDeclared.has("last")).toBe(false);
    expect(m.unreadable.some((g) => g.note.includes("more than"))).toBe(true);
  });

  it("reads an included file only up to the byte cap, and says when it is over (5)", () => {
    const m = model({ "requirements.txt": "-r big.txt\n", "big.txt": `django\n${"# filler\n".repeat(Math.ceil(MANIFEST_BYTES / 9) + 10)}` });
    expect(m.unreadable.some((g) => g.file === "big.txt")).toBe(true);
  });

  it("detects a Django application whose dependency only an included file declares (1)", async () => {
    const root = makeRepo({
      "requirements.txt": "-r requirements/base.txt\n",
      "requirements/base.txt": "Django==5.0\n",
      "mysite/__init__.py": "",
      "mysite/settings.py": 'INSTALLED_APPS = []\nROOT_URLCONF = "mysite.urls"\n',
      "mysite/urls.py": "from django.urls import path\n\nfrom mysite import views\n\nurlpatterns = [path(\"a/\", views.a)]\n",
      "mysite/views.py": "def a(request):\n    return None\n",
    });
    commitAll(root);
    const graph = await buildGraph({ repoRoot: root, store: null });
    expect(graph.frameworks?.apps.length).toBe(1);
  }, 60_000);
});
