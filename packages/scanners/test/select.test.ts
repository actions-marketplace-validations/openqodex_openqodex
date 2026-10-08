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
//  13. A hostile manifest, script or YAML file from the repo (long runs of
//      blanks with no closing quote, bracket or comment) makes a pattern
//      backtrack without bound, so reading it hangs the review.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "@openqodex/core";
import type { Config } from "@openqodex/core";
import { MAX_MANIFEST_BYTES, repoFacts } from "../src/detect.js";
import { choiceLine, repoInventory, selectScanners } from "../src/select.js";

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

describe("hostile files read in linear time (13)", () => {
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

describe("the reason lines", () => {
  it("are one line each with no control character, whatever the file name (11)", () => {
    const dir = repo({ "bad\u001b[31mname\n.sh": "echo hi\n" });
    const lines = selectScanners({ repoDir: dir, paths: ["bad\u001b[31mname\n.sh"], config: config() }).map(choiceLine);
    for (const line of lines) {
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(lines.find((l) => l.startsWith("shellcheck:"))).toContain("shell scripts");
  });
});
