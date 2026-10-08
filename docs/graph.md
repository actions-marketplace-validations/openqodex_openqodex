# The code graph

The code graph is a map of your repository: every function, method, class and type as a point, and every call, import and inheritance between them as a line, with the proof attached. `openqodex review` builds it on your machine and puts what your change reaches into the reviewer's brief. No model is called to build it and nothing is sent anywhere.

## What it answers

For a review, the brief's block "What this change reaches" lists:

- the symbols the change touches, removes or moves (a move under another name is found by the same body);
- the public names the change removed or bound to another definition, compared in the base and the changed version, with every place that used them and what each binds now;
- who calls the touched code, one and two hops out, certain callers first;
- what the touched code calls, and the files that import a changed file;
- what the graph could not see near the change, and whether each caller list is complete or a floor.

Everything the brief leaves out is in the review's packet (below).

## Certain, likely and possible

Every call site on a line carries the evidence that proved it and one of these levels:

- certain: an import that names the symbol, a definition in the same scope or Go package, or a receiver whose type a constructor, an annotation, a declared result or `this`/`self` gives, and every step it rests on is proved the same way. A name match alone is never certain.
- likely: a stated convention picked the one target. The line says which convention, for example a workspace package reached through its built `dist` entry with no tsconfig `paths`, project reference or source condition mapping it to source, or a Ruby constant found by the autoload convention.
- possible: the call reaches one of several definitions and nothing picks one, such as a name that two `export *` statements bring from different modules (JavaScript exports neither; a bundler may pick one). Each candidate is listed with the note. Calls through interfaces, also possible, come in a later release.

A step through inheritance is part of the proof: a method found on a base class is no surer than the binding of that base class, for a call on an instance and for `super`.

## Workspaces and source roots

- A bare import that names a package of the workspace (`pnpm-workspace.yaml`, or `workspaces` in `package.json`) binds when the importing package declares it: with `workspace:`, with a `file:` or `link:` path that leads to that package's own folder, or with a version range a lockfile resolves to the workspace. A lockfile that resolves it to a published version keeps the call external. A package that does not declare it is not assumed. A `file:` or `link:` path is walked in the work tree one folder at a time from the declaring package's folder, and binds only when the folder it reaches is that package's folder on disk (the same device and inode), not a folder spelled the same. A path that leads to any other folder of the repository is never bound by the name alone and stays an unknown, and so does one that passes through a symbolic link or through a name that is not a folder, which the note names; a path that climbs above the repository root through real folders is external.
- The package's entry comes from `exports` (in key order, `types` never), then `module` and `main`. A package with an `exports` map exposes only what the map lists: any other path is not bound and is recorded as not exported, as Node refuses it. Without an `exports` map, a path such as `pkg/src/x` is found by the package's folders. A source entry is certain; a built entry mapped back to `src` (through the package tsconfig's `outDir` and `rootDir`, or `dist` to `src`) is likely, and certain when the importer's tsconfig references the package as a project.
- The nearest `tsconfig.json` or `jsconfig.json` above a file governs it, with relative `extends` followed (up to five configs in one chain; an `extends` that names a package is read for the config's own options only). Its `paths` and `baseUrl` prove an import when its `files`, `include` and `exclude` list the file; otherwise the binding is likely.
- Python absolute imports search the importing file's own folders, every `src` folder that holds a package, every folder with a `pyproject.toml`, `setup.cfg` or `setup.py`, and namespace packages without `__init__.py`. A module found in two places (next to the importer, or under two roots) is not bound and is recorded as ambiguous. A module file or a regular package wins over a namespace package, as in Python.
- Manifests and tsconfig files are read as text, each up to 1 MB, and lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) up to 16 MB; a larger file is not read. Each is read in one pass, so a crafted file cannot make the graph hang. Nothing in the repository is run.
- A manifest, lockfile or tsconfig the graph cannot read, parse or follow (over its cap, not valid JSON, a link, a relative `extends` that names a file not in the repository) is never dropped quietly. It becomes an unknown that names the file and what failed, and a reason line of the build. A file that git lists but the work tree no longer holds is no failure. What else follows depends on what its loss can hide:

| File | Its loss can hide | Then |
| --- | --- | --- |
| `package.json` | calls, inheritance and imports | caller lists in its folder are floors; the build is partial and keeps no index |
| `tsconfig.json`, `jsconfig.json` | calls, inheritance and imports | the same |
| `pnpm-workspace.yaml` | calls, inheritance and imports | the same |
| `go.mod` | calls and imports | the same |
| `pyproject.toml`, `setup.cfg`, `requirements*.txt` | nothing: imports of what it declares read as misses | the build stays complete |
| `Gemfile` | nothing: requires of the gems it names read as misses | the build stays complete |
| `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock` | nothing: a binding through it is only less sure | the build stays complete |

  A kept index is matched by every file the graph read or looked for while it worked out the projects, whatever its name (a tsconfig may extend `./configs/base`, with no extension), with its content, and by whether each file it looked for was there. It is never reused once one of them changes, appears or goes.

## What it cannot see

A call no rule can bind is kept as an unknown with its cause, never dropped:

- external: the name comes from a declared dependency or the standard library. Only these are external; an import of a module that is not in the repository and that no manifest declares is a miss.
- no-receiver-type: a method called on a value whose type no rule knows, or on an interface or a type alias (calls through interfaces come later).
- untyped-receiver: a method called on a value typed `any`, `unknown`, `object` or an object type written in place such as `{ save(): number }` (Python `object` or `Any`, Go `any`). It may reach any method of that name, so it is never counted as external.
- not-exported: a path of a workspace package that its `exports` map does not expose.
- dynamic: a call through a parameter, a local value or a computed member such as `handlers[key]()`. Such a call could reach any function of its project.
- miss: the evidence names a place where no such symbol exists now.
- ambiguous: several definitions could be meant and nothing picks one.
- budget: the time budget ran out before the file's calls were resolved.
- export-chain-too-deep: the name is re-exported or aliased through more than 8 modules, and the graph stops following it there.
- unsupported-rule: the evidence leads somewhere no rule binds through, such as a `file:` dependency into a folder of the repository that is no workspace package.
- metadata-unreadable: a manifest, lockfile or tsconfig the graph could not read, parse or follow; the note names the file and what failed.

A caller list is a floor, and the brief says so with the reasons, when a call of the same name could not be bound, a call through a value in the symbol's project could reach it, a file of its project was not read, a file that imports it was not resolved, a manifest or tsconfig governing its folder could not be read, or a walk was cut at it. Zero callers on a floor never means unused.

Every cut is recorded with what it left out: a symbol with more than 40 callers keeps its 20 nearest in the brief, the second hop keeps 20 callers of each caller, the walk stops at 200 symbols (what lies past that frontier is not counted), the brief shows 60 call sites, the summary keeps the first 200 places that used each changed public name (the brief shows 8), and the walk of `export *` re-exports opens at most 4,096 files in one version of the code (names re-exported past that are not compared). Each barrel file is walked once, so two files that `export *` from each other end the walk where the cycle closes.

Languages: TypeScript, TSX, JavaScript, Python, Go and Ruby. Files under `node_modules`, `dist`, `build`, `out`, `vendor` and the like, declaration files and minified files are left out.

A file is listed as not read, with the reason, when it is over `graph.max_file_bytes`, past the `graph.max_files` parse cap, past the time budget or the memory bound, or when its parse takes over two seconds (the parser is slow on some broken files). Every one of these holds for the changed files too: they are read first, so a cap reached late never loses them.

## Limits

- A dependency that a lockfile links by path (a pnpm `link:` entry, `link: true` in `package-lock.json`) or that yarn declares as `workspace:<path>` is bound to the workspace package of its name, not by where the path leads.
- A `file:` or `link:` path with a symbolic link on its way is never bound, even where npm or pnpm would link the workspace package through it.
- A tsconfig `extends` given as a list (TypeScript 5) is not followed: it is a metadata-unreadable unknown, and the build is partial.
- A facts file in `.openqodex/graph/` is trusted when you own it and only you can write it, so facts planted with your own user, for example by an archive you extracted over the repository, are read as the graph's own.

## The graph's folder

The graph lives in the repository, in `.openqodex/graph/`, which the folder's own `.gitignore` keeps out of git. It holds:

- `facts/`: what one parse of one file found, one file per content, so a file that did not change is never parsed again, in any build or any checkout of the repository.
- `generations/<build id>/`: one folder per build, never changed after it is written: what the build read (paths and content ids), the project model, what it could not read, and for a build kept as an index the resolved graph.
- `current` and `complete/<tree>`: the newest usable build and the newest complete build of each capture.
- `leases/`: one file per process that holds a build open. A build a review or a command holds is never removed while it runs.
- `meta.json`: the rates this machine measured, for the five-second rule.

A build's folder is written whole and checked against its own checksums before `current` moves to it, so a reader never sees half a build. Its checksum is also recorded in your home, in `~/.openqodex/graph/`, and a build is used only when that record matches it: a build copied into the folder, or one changed in it, is never read. The folder, its own folders and every file read from it must be yours and closed to writes by other users; when the folder is not, the graph is built in memory and the run says why, and a facts file that is not is parsed again. The collector keeps the newest build, the two newest complete builds and every build a live process holds, removes facts no kept build names (only when every kept build is complete, and only facts older than an hour), and keeps the folder under `graph.max_cache_mb` (512 MB by default). Over the bound it removes, oldest first, the facts no kept build names, then older builds no process holds (never the newest one), then the facts only those builds named, then the facts of kept builds no process holds. When the builds in use alone are larger than the bound, the build is still kept and the run says so. A build never writes facts past the bound: those files are parsed again next time, and the run says how many.

Each kept build's capture is a git tree in the repository's own objects, held by a local ref `refs/openqodex/graph/<tree>` while a build of it is kept, so `git show <tree>:<path>` shows the exact bytes the graph read after the files change. The ref is never pushed by a plain `git push`; `git push --mirror` would push it.

With `--report-dir` (the GitHub Action) nothing is written under `.openqodex/`: the graph is built in memory and nothing is kept.

## The five-second rule

Each build predicts its own time from what it will do: files with no cached facts at the parse rate this machine measured, cached facts at the measured read rate, and the rest per file. The first build uses 400 parses a second, 2,500 cached facts a second and 0.25 s per 1,000 files for the rest; later builds use the rates earlier builds measured (a rate is measured over 20 files or more).

- Under five seconds: the graph is built fresh from the cached facts, parsing only what is new.
- Over five seconds: a graph command loads the kept index of the same capture when there is one. A review, which compares two versions, and a capture with no kept index build under the time budget, changed files first, and keep an index for the next time.

The mode changes only after two builds in a row land on the other side of the line.

A large repository may be partial on its first reviews: the `graph.max_files` cap counts new parses only, so cached facts never count toward it and each review adds more. The brief and the report say so, and `openqodex graph build` completes it in one run (no parse cap, a ten-minute budget, the memory bound kept).

## The review's packet

`openqodex review` writes the graph's files into the review's snapshot, under `.openqodex-review/graph/`, before the snapshot is hashed, so the reviewer opens them inside the one folder it may read:

- `index.md`: one line per file below.
- `impact.json`: the summary the brief was made from.
- `changes.json`: every public name the change removed or bound elsewhere, every place that used each one with what it binds now (past the summary's cut), and the removed and moved symbols.
- `callers/<key>.json`: every caller of each touched or removed symbol, in pages of 500, past any cut the brief makes.
- `second-hop/<key>.json`, `callees/<key>.json`, `importers/<key>.json`: the same for the second hop, what the touched code calls, and who imports a changed file.
- `unknowns.json`: what the graph could not see near the change, with causes.
- `status.json`, `capabilities.json`: how the graph was built and what it can see.
- `base/<key>.txt`: the base version of each removed or moved symbol, labelled as not the code under review.

`changes.json` and the files under `callers/`, `second-hop/`, `callees/` and `importers/` come in pages of 500 items. Each page names the next one in `next` (`changes.2.json`, then `changes.3.json`). Each page says `total`, the items on all the pages, and `totalExact`, true when they are the whole list. When they are not, `cut.omitted` says how many are missing, or is null when that cannot be counted.

Every file passes through the review's secret redaction. A repository that holds a path named `.openqodex-review` stops the review instead of being overwritten.

## The graph commands

These commands are hidden from the menu and may change before 1.0. Each runs on a capture of your work tree, building or reusing the graph in `.openqodex/graph/`, or on a kept build with `--generation <id>`, which never builds. `build --full` builds fresh from facts even over the five-second line.

```
openqodex graph build [--full]
openqodex graph status
openqodex graph capabilities
openqodex graph search <text>
openqodex graph symbol <name | file:line>
openqodex graph callers <name | file:line> [--file <path>] [--tier certain,likely] [--depth 1..3]
openqodex graph callees <name | file:line>
openqodex graph importers <file>
openqodex graph changes [--base <ref>]
openqodex graph unknowns [--file <path> | --name <name>]
openqodex graph explain <edge id>
```

`--json` prints the answer as it is: the items with their evidence and level, the true counts by level, search hits as leads that are never counted, whether the answer is a floor and why, how it was cut (with `--cursor` for the next page), and which build answered. A name that matches several definitions returns them all as candidates. Exit code 0 means an answer, partial or a floor included; 2 means the request could not be answered.

## Settings

The `graph` keys of `.openqodex/config.yaml` are in `config`: `graph.enabled`, `graph.budget_ms`, `graph.max_files` (new parses per build), `graph.max_file_bytes`, `graph.max_cache_mb` and `graph.max_heap_mb`. `--no-graph` turns the graph off for one review.
