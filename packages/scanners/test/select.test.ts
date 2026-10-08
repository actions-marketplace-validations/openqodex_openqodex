// The shared scanner selector and the repo facts it reads, on real temp
// repos: what `init`, `doctor --install`, the GitHub Action and a review
// decide to run and download, and why.
//
// Failure list, written before the code:
//   1. A React Native app made with Expo, with the template's root Gemfile
//      (CocoaPods) and an Expo Router app/ folder, selects brakeman or
//      rubocop over its files (the reported TypeScript user).
//   2. A Rails app in backend/ (rails in backend/Gemfile, backend/config/
//      application.rb) is not selected for a changed controller, or the
//      selection does not name backend/.
//   3. A Jekyll site (a root Gemfile without rails, an app/ folder) selects
//      brakeman.
//   4. A Gemfile that names rails, with no config/application.rb and no
//      bin/rails, selects brakeman; or its Ruby files lose rubocop, so
//      evidence that is not enough switches a generic check off.
//   5. A frontend-only change in a Rails repo selects brakeman.
//   6. A scanner in scanners.disable is wanted; a path the config excludes
//      calls for a scanner from the inventory.
//   7. An extensionless script with an sh or bash shebang does not select
//      shellcheck; a binary file, a link out of the repo or a zsh script does.
//   8. A YAML file with top-level apiVersion and kind is not classed as
//      Kubernetes; a workflow or a compose file is.
//   9. A manifest over the size cap, or a link to a manifest outside the
//      repo, is read.
//  10. A monorepo's files map to the wrong project: web/ (Next.js), api/
//      (Rails), ml/ (FastAPI and Django).
//  11. A selection line spans more than one line or carries a control
//      character from a file name.
//  12. A Python dependency is missed in [project] dependencies, a poetry
//      table or a requirements file; or a name in a description or an isort
//      list counts as a dependency.
//  13. A lockfile osv-scanner 2 reads (bun.lock, uv.lock, pdm.lock, the NuGet
//      ones) is left out, or a file it has no extractor for (go.sum,
//      package.json) is handed to it, which stops the whole lockfile run.
//  14. A hostile manifest, script or YAML file from the repo (long runs of
//      blanks with no closing quote, bracket or comment) makes a pattern
//      backtrack without bound, so reading it hangs the review.
// Added after the code review:
//  15. A Gemfile that declares rails over several lines (`gem(` then the
//      name on the next line) is missed, so a Rails app without a lockfile
//      loses brakeman.
//  16. An `{include-group = "django"}` reference in [dependency-groups] is
//      read as the package django.
//  17. A link in a folder on the way to a manifest or a marker
//      (backend/config -> ../shared) supplies it, though the docs say never
//      through a link.
//  18. Grouping the files of a whole repository by their framework rules
//      takes time that grows with the square of the file count.
//  19. A quoted TOML key with dots in it (["tool.poetry.dependencies"]) is
//      read as the nested Poetry table, or a dotted header with quoted parts
//      or blanks around its dots ([tool."poetry".dependencies]) is not.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import type { Config } from "@openqodex/core";
import { MAX_MANIFEST_BYTES, repoFacts } from "../src/detect.js";
import { choiceLine, repoInventory, selectScanners } from "../src/select.js";
import { oxlintGroups } from "../src/adapters/oxlint.js";
import { ruffGroups } from "../src/adapters/ruff.js";

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string | Buffer>, git = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openqodex-select-"));
  roots.push(dir);
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function config(yaml = ""): Config {
  return parseConfig(yaml).config;
}

function wanted(dir: string, paths: string[], cfg = config()): string[] {
  return selectScanners({ repoDir: dir, paths, config: cfg })
    .filter((c) => c.wanted)
    .map((c) => c.scanner)
    .sort();
}

// The React Native template's Gemfile pins CocoaPods for the iOS build.
const EXPO = {
  "package.json": JSON.stringify({ name: "app", dependencies: { expo: "~52.0.0", "expo-router": "~4.0.0", react: "18.3.1", "react-native": "0.76.0" } }),
  "app/_layout.tsx": "export default function Layout() { return null; }\n",
  "app/index.tsx": "export default function Home() { return null; }\n",
  Gemfile: "source 'https://rubygems.org'\nruby '>= 2.6.10'\ngem 'cocoapods', '>= 1.13', '< 1.15'\n",
  "ios/Podfile": "platform :ios, '13.4'\n",
};

const RAILS_BACKEND = {
  "web/package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  "web/app/page.tsx": "export default function Page() { return null; }\n",
  "backend/Gemfile": "source 'https://rubygems.org'\ngem \"rails\", \"~> 7.1\"\n",
  "backend/config/application.rb": "require 'rails/all'\nmodule Api\n  class Application < Rails::Application\n  end\nend\n",
  "backend/app/controllers/users_controller.rb": "class UsersController < ApplicationController\n  def index\n    User.where(\"name = '#{params[:name]}'\")\n  end\nend\n",
};

describe("brakeman runs only for a Rails app, wherever it is", () => {
  it("an Expo app with the React Native Gemfile selects neither brakeman nor rubocop over its files (1)", async () => {
    const dir = repo(EXPO);
    const inventory = await repoInventory(dir, config());
    expect(inventory).toContain("Gemfile");
    expect(wanted(dir, inventory)).toEqual(["gitleaks", "oxlint", "semgrep"]);
    // A change to the Gemfile itself still does not make it a Rails app.
    expect(wanted(dir, ["Gemfile"])).not.toContain("brakeman");
  });

  it("a Rails app in backend/ selects brakeman for a changed controller and names backend/ (2)", () => {
    const dir = repo(RAILS_BACKEND);
    const choice = selectScanners({ repoDir: dir, paths: ["backend/app/controllers/users_controller.rb"], config: config() }).find((c) => c.scanner === "brakeman")!;
    expect(choice.wanted).toBe(true);
    expect(choice.projects).toEqual(["backend"]);
    expect(choiceLine(choice)).toBe("brakeman: Rails app in backend/");
  });

  it("a Rails app at the root, found by bin/rails and Gemfile.lock, is named as the repository root (2)", () => {
    const dir = repo({
      Gemfile: "gem 'rails'\n",
      "Gemfile.lock": "GEM\n  remote: https://rubygems.org/\n  specs:\n    railties (7.1.3)\n\nDEPENDENCIES\n  rails\n",
      "bin/rails": "#!/usr/bin/env ruby\n",
      "app/models/user.rb": "class User; end\n",
    });
    const choice = selectScanners({ repoDir: dir, paths: ["app/models/user.rb"], config: config() }).find((c) => c.scanner === "brakeman")!;
    expect(choiceLine(choice)).toBe("brakeman: Rails app at the repository root");
  });

  it("a Jekyll site with a root Gemfile and an app/ folder never selects brakeman (3)", () => {
    const dir = repo({
      Gemfile: "source 'https://rubygems.org'\ngem 'jekyll', '~> 4.3'\n",
      "app/main.ts": "export const x = 1;\n",
      "_plugins/tags.rb": "module Jekyll; end\n",
    });
    expect(wanted(dir, ["Gemfile", "_plugins/tags.rb"])).not.toContain("brakeman");
    expect(wanted(dir, ["_plugins/tags.rb"])).toContain("rubocop");
  });

  it("rails in the Gemfile without config/application.rb or bin/rails keeps rubocop and leaves brakeman out (4)", () => {
    const dir = repo({ Gemfile: "gem 'rails'\n", "lib/tool.rb": "x = 1\n" });
    const picked = wanted(dir, ["lib/tool.rb"]);
    expect(picked).not.toContain("brakeman");
    expect(picked).toContain("rubocop");
    expect(selectScanners({ repoDir: dir, paths: ["lib/tool.rb"], config: config() }).find((c) => c.scanner === "brakeman")!.skip).toBe("no Rails app holds a changed Ruby file");
  });

  it("a frontend-only change in a repo with a Rails app selects no brakeman (5)", () => {
    const dir = repo(RAILS_BACKEND);
    expect(wanted(dir, ["web/app/page.tsx"])).toEqual(["gitleaks", "oxlint", "semgrep"]);
  });
});

describe("the config decides before any file does", () => {
  it("a disabled scanner is never wanted, and an excluded path calls for nothing (6)", async () => {
    const dir = repo({ ...RAILS_BACKEND, "vendor/tool.py": "import os\n" });
    const cfg = config("scanners:\n  disable: [brakeman, oxlint]\nreview:\n  paths:\n    exclude: [\"vendor/**\"]\n");
    const inventory = await repoInventory(dir, cfg);
    expect(inventory).not.toContain("vendor/tool.py");
    const choices = selectScanners({ repoDir: dir, paths: inventory, config: cfg });
    const brakeman = choices.find((c) => c.scanner === "brakeman")!;
    expect(brakeman).toMatchObject({ wanted: false, skip: "disabled in .openqodex/config.yaml" });
    expect(choices.find((c) => c.scanner === "oxlint")!.wanted).toBe(false);
    expect(choices.find((c) => c.scanner === "ruff")!.wanted).toBe(false);
    expect(choices.find((c) => c.scanner === "rubocop")!.wanted).toBe(true);
  });
});

describe("what a file's first bytes say", () => {
  it("an extensionless sh or bash script selects shellcheck; a binary, a link out and a zsh script do not (7)", () => {
    const outside = repo({ "deploy": "#!/bin/bash\necho $1\n" }, false);
    const dir = repo({
      "bin/deploy": "#!/usr/bin/env bash\nrm -rf $DIR/\n",
      "bin/setup": "#!/bin/sh\necho hi\n",
      "bin/tool": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]),
      "bin/zshrc": "#!/bin/zsh\necho hi\n",
    });
    fs.symlinkSync(path.join(outside, "deploy"), path.join(dir, "bin/linked"));
    const facts = repoFacts(dir);
    expect(facts.content("bin/deploy")).toBe("shell");
    expect(facts.content("bin/setup")).toBe("shell");
    expect(facts.content("bin/tool")).toBeNull();
    expect(facts.content("bin/zshrc")).toBeNull();
    expect(facts.content("bin/linked")).toBeNull();
    const choice = selectScanners({ repoDir: dir, paths: ["bin/deploy", "bin/setup", "bin/tool", "bin/zshrc", "bin/linked"], config: config() }).find((c) => c.scanner === "shellcheck")!;
    expect(choice.paths).toEqual(["bin/deploy", "bin/setup"]);
  });

  it("a YAML file with top-level apiVersion and kind is Kubernetes; a workflow and a compose file are not (8)", () => {
    const dir = repo({
      "k8s/deploy.yaml": "# a comment\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
      "k8s/two.yml": "foo: bar\n---\napiVersion: v1\nkind: Service\n",
      ".github/workflows/ci.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n",
      "compose.yaml": "services:\n  web:\n    image: nginx\n",
      "nested.yaml": "spec:\n  apiVersion: v1\n  kind: Pod\n",
    });
    const facts = repoFacts(dir);
    expect(facts.content("k8s/deploy.yaml")).toBe("kubernetes");
    expect(facts.content("k8s/two.yml")).toBe("kubernetes");
    expect(facts.content(".github/workflows/ci.yml")).toBeNull();
    expect(facts.content("compose.yaml")).toBeNull();
    expect(facts.content("nested.yaml")).toBeNull();
  });

  // A Helm template is not YAML until Helm renders it: a Kubernetes scanner
  // handed one reads `{{ .Values.x }}` as broken YAML and fails or reports
  // lines that do not exist.
  it("a Helm template with apiVersion and kind is not Kubernetes", () => {
    const dir = repo({
      "chart/Chart.yaml": "apiVersion: v2\nname: web\nversion: 1.0.0\n",
      "chart/templates/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n",
    });
    expect(repoFacts(dir).content("chart/templates/deploy.yaml")).toBeNull();
  });
});

describe("manifests are data, read within limits", () => {
  it("a manifest over the size cap, or a link to one outside the repo, is not read (9)", () => {
    const outside = repo({ "package.json": JSON.stringify({ dependencies: { react: "18" } }) }, false);
    const big = JSON.stringify({ dependencies: { react: "18" }, padding: "x".repeat(2 * 1024 * 1024) });
    const dir = repo({ "big/package.json": big, "big/a.tsx": "x\n", "linked/a.tsx": "x\n" });
    fs.symlinkSync(path.join(outside, "package.json"), path.join(dir, "linked/package.json"));
    const facts = repoFacts(dir);
    expect(facts.project("big/a.tsx")).toMatchObject({ root: "big", frameworks: [] });
    // A link is not a manifest: the file belongs to no project here.
    expect(facts.project("linked/a.tsx")?.frameworks ?? []).toEqual([]);
  });

  it("maps each file of a monorepo to its nearest project and that project's frameworks (10)", () => {
    const dir = repo({
      ...RAILS_BACKEND,
      "ml/pyproject.toml": '[project]\nname = "ml"\ndependencies = [\n  "fastapi>=0.110",\n  "Django[argon2] ~= 5.0",\n]\n',
      "ml/serve.py": "import fastapi\n",
    });
    const facts = repoFacts(dir);
    expect(facts.project("web/app/page.tsx")).toMatchObject({ root: "web", frameworks: ["nextjs", "react"] });
    expect(facts.project("backend/app/controllers/users_controller.rb")).toMatchObject({ root: "backend", frameworks: ["rails"] });
    expect(facts.project("ml/serve.py")).toMatchObject({ root: "ml", frameworks: ["django", "fastapi"] });
    expect(facts.project("README.md")).toBeNull();
  });

  it("reads Python dependencies from their lists only (12)", () => {
    const dir = repo({
      "a/pyproject.toml": '[project]\nname = "a"\ndescription = "django helpers"\n\n[tool.isort]\nknown-third-party = ["fastapi"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\napache-airflow = "^2.9"\n',
      "a/x.py": "x = 1\n",
      "b/requirements-dev.txt": "# tools\n-r requirements.txt\nDjango==5.0 ; python_version >= '3.10'\n",
      "b/x.py": "x = 1\n",
    });
    const facts = repoFacts(dir);
    expect(facts.project("a/x.py")).toMatchObject({ frameworks: ["airflow"] });
    expect(facts.project("b/x.py")).toMatchObject({ frameworks: ["django"] });
  });
});

describe("the lockfiles osv-scanner gets (13)", () => {
  it("hands over every lockfile osv-scanner 2 reads and none it cannot", () => {
    const dir = repo({});
    const reads = ["bun.lock", "web/uv.lock", "pdm.lock", "pylock.toml", "api/packages.lock.json", "packages.config", "requirements-dev.txt", "App.deps.json", "gems.locked", "renv.lock", "gradle/verification-metadata.xml", "go.mod", "package-lock.json"];
    const never = ["go.sum", "package.json", "deps.json", "Pipfile", "requirements.in"];
    const choice = selectScanners({ repoDir: dir, paths: [...reads, ...never], config: config() }).find((c) => c.scanner === "osv-scanner")!;
    expect(choice.paths).toEqual(reads);
  });
});

describe("hostile files read in linear time (14)", () => {
  // Just under the cap, so the whole file is read.
  const N = MAX_MANIFEST_BYTES - 1024;
  const blanks = (n: number) => " ".repeat(n);
  const hostile: [string, Record<string, string>, string][] = [
    ["package.json", { "package.json": `{"dependencies":{"react":"1"},"x":"${blanks(N / 2)}","y":${"[".repeat(N / 4)}` }, "a.ts"],
    ["Gemfile", { Gemfile: `${"\n".repeat(N / 2)}gem${blanks(N / 2)}`, "config/application.rb": "x\n" }, "a.rb"],
    ["Gemfile.lock", { "Gemfile.lock": `  ${"a".repeat(N / 2)}${blanks(N / 2)}`, "bin/rails": "x\n" }, "a.rb"],
    ["pyproject.toml", { "pyproject.toml": `[a${blanks(N / 2)}x\n[project]\ndependencies = [\n"a${blanks(N / 2)}x"\n` }, "a.py"],
    ["requirements.txt", { "requirements.txt": `a${blanks(N)}x\n` }, "a.py"],
    ["Pipfile", { Pipfile: `[packages]\n"a${blanks(N)}x\n` }, "a.py"],
    ["Gemfile of gem( lines", { Gemfile: "gem(\n".repeat(N / 5) }, "a.rb"],
  ];
  for (const [kind, files, file] of hostile) {
    it(`a hostile ${kind} of 1 MB is read in well under a second`, () => {
      const dir = repo({ ...files, [file]: "x\n" }, false);
      const started = performance.now();
      const project = repoFacts(dir).project(file);
      expect(performance.now() - started).toBeLessThan(500);
      expect(project).toMatchObject({ root: "", frameworks: [] });
    });
  }

  it("a hostile extensionless script or YAML file of 1 MB is classed in well under a second", () => {
    const dir = repo({ "bin/run": `#!${"/env ".repeat(N / 5)}`, "k8s/a.yaml": `apiVersion:${blanks(N)}`, "k8s/b.yaml": `${"apiVersion:\n".repeat(N / 12)}` }, false);
    const facts = repoFacts(dir);
    const started = performance.now();
    expect(facts.content("bin/run")).toBeNull();
    expect(facts.content("k8s/a.yaml")).toBeNull();
    expect(facts.content("k8s/b.yaml")).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("what the code review found in the readers", () => {
  it("a Gemfile that declares rails over several lines, with no lockfile, still makes a Rails app (15)", () => {
    const dir = repo({
      Gemfile: "source 'https://rubygems.org'\ngem(\n  # the framework\n  \"rails\",\n  \"~> 7.1\"\n)\ngem 'puma'\n",
      "config/application.rb": "require 'rails/all'\n",
      "app/models/user.rb": "class User; end\n",
    });
    expect(repoFacts(dir).project("app/models/user.rb")).toMatchObject({ frameworks: ["rails"] });
    expect(wanted(dir, ["app/models/user.rb"])).toContain("brakeman");
  });

  it("an include-group reference in [dependency-groups] is not a package, while the strings beside it are (16)", () => {
    const dir = repo({
      "a/pyproject.toml": '[project]\nname = "a"\n\n[dependency-groups]\ndjango = ["pytest"]\ndev = [{include-group = "django"}, "fastapi>=0.110"]\n',
      "a/x.py": "x = 1\n",
    });
    expect(repoFacts(dir).project("a/x.py")).toMatchObject({ frameworks: ["fastapi"] });
  });

  it("a link in any folder on the way to a manifest or a marker supplies nothing (17)", () => {
    const dir = repo({
      "backend/Gemfile": "gem 'rails'\n",
      "backend/app/models/user.rb": "class User; end\n",
      "shared/application.rb": "require 'rails/all'\n",
      "app/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "app/page.tsx": "x\n",
    });
    fs.symlinkSync("../shared", path.join(dir, "backend/config"));
    fs.symlinkSync("app", path.join(dir, "web"));
    const facts = repoFacts(dir);
    expect(facts.project("backend/app/models/user.rb")).toMatchObject({ root: "backend", frameworks: [] });
    expect(facts.project("app/page.tsx")).toMatchObject({ root: "app", frameworks: ["react"] });
    expect(facts.project("web/page.tsx")).toBeNull();
  });

  it("groups 100,000 files by their framework rules in well under a second (18)", () => {
    const dir = repo({
      "web/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "ml/requirements.txt": "django==5.0\n",
    });
    const facts = repoFacts(dir);
    const js = Array.from({ length: 100_000 }, (_, i) => `${i % 2 === 0 ? "web" : "lib"}/f${i}.ts`);
    const py = Array.from({ length: 100_000 }, (_, i) => `${i % 2 === 0 ? "ml" : "lib"}/f${i}.py`);
    const started = performance.now();
    const ox = oxlintGroups(js, facts);
    const rf = ruffGroups(py, facts);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(ox.get("react,jsx-a11y")).toHaveLength(50_000);
    expect(ox.get("")).toHaveLength(50_000);
    expect(rf.get("DJ")).toHaveLength(50_000);
    expect(rf.get("")).toHaveLength(50_000);
  });
});

describe("TOML table names (19)", () => {
  it("reads a quoted key as one name and a dotted name part by part", () => {
    const dir = repo({
      "a/pyproject.toml": '["tool.poetry.dependencies"]\ndjango = "^5.0"\n',
      "a/x.py": "x\n",
      "b/pyproject.toml": '[tool."poetry".dependencies]\ndjango = "^5.0"\n',
      "b/x.py": "x\n",
      "c/pyproject.toml": '[ tool . poetry . dependencies ]  # the app\nfastapi = "^0.110"\n',
      "c/x.py": "x\n",
      "d/pyproject.toml": '[tool.poetry.group."ci.extra".dependencies]\napache-airflow = "^2.9"\n',
      "d/x.py": "x\n",
      "e/pyproject.toml": "['tool.poetry'.dependencies]\ndjango = \"^5.0\"\n",
      "e/x.py": "x\n",
    });
    const facts = repoFacts(dir);
    expect(facts.project("a/x.py")).toMatchObject({ frameworks: [] });
    expect(facts.project("b/x.py")).toMatchObject({ frameworks: ["django"] });
    expect(facts.project("c/x.py")).toMatchObject({ frameworks: ["fastapi"] });
    expect(facts.project("d/x.py")).toMatchObject({ frameworks: ["airflow"] });
    expect(facts.project("e/x.py")).toMatchObject({ frameworks: [] });
  });
});

describe("the reason lines", () => {
  it("are one line each with no control character, whatever the file name (11)", () => {
    const dir = repo({ "bad\u001b[31mname\n.sh": "echo hi\n" });
    const lines = selectScanners({ repoDir: dir, paths: ["bad\u001b[31mname\n.sh"], config: config() }).map(choiceLine);
    for (const line of lines) {
      // Matching control characters is the point here.
      // oxlint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(lines.find((l) => l.startsWith("shellcheck:"))).toContain("shell scripts");
  });
});
