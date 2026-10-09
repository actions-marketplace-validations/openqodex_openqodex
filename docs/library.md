# Library

`openqodex` is also a library. A Node program, on Node 22 or newer, imports the scanners, the code graph, the lenses, the config parser and the renderers from the same package the command comes from, with TypeScript types.

```
npm install openqodex
```

```ts
import { createToolResolver, parseConfig, renderMarkdown, runScanners } from "openqodex";
import { graph, lenses, render, scanners } from "openqodex";
```

Every function is a named export. The four namespaces `scanners`, `graph`, `lenses` and `render` hold the same functions, grouped by what they belong to: `scanners.runScanners` is `runScanners`. The package is ESM only: load it with `import`, not `require`.

Importing the library runs nothing. No command starts, nothing is printed, no environment variable is set, no signal handler is added and no update check runs. A function does its work only when it is called.

## Bundling

The library finds its files from where it is installed: the lenses in `lenses/`, the pinned scanner table `toolchain.json` with its lock files in `locks/`, and the tree-sitter grammars in `wasm/`, all beside `dist/` in the package. A program that bundles its own code must leave `openqodex` out of the bundle (`external: ["openqodex"]` in esbuild, or the same setting in another bundler), so these files resolve from the installed package. Inlined into a bundle, the library looks for them beside the bundle and finds none of them.

## scanners

`runScanners(args)` runs the built-in scanners that fit the changed files and returns `Promise<RunScannersResult>`, which is `{ scan, secrets, checked }`.

- `repoDir`: the folder the scanners read.
- `changedPaths`: the changed files, relative to `repoDir`.
- `coverage` (optional): a `Map` from each path to the set of its changed line numbers. With it, only findings on changed lines are kept. Without it, every finding in a changed file is kept.
- `baseText` (optional): `(path) => Promise<string | null>`, the base version of a file. With it, a change to what a scanner reads from a shared settings file, such as `pyproject.toml`, is reported.
- `config`: a `Config`, from `parseConfig` or `loadConfig`.
- `resolveTool`: from `createToolResolver`.
- `only` and `skip` (optional): scanner names to run, or to leave out.
- `onProgress` (optional): called with one line per step.
- `custom` (optional): custom scanners that the command's trust step prepared. Leave it out.

In the result, `scan.candidates` are the findings and `scan.scanners` has one summary per scanner: whether it ran, and why not when it did not. `secrets` holds the raw secrets the scanners matched, for redacting text; never store it. `checked` maps each scanner rule that ran to the files it checked.

`createToolResolver({ allowInstall, installBudgetMs, onProgress })` returns a `ResolveTool`: `(scanner) => Promise<ToolResolution>`. A scanner is never taken from PATH. Only the pinned version under `$OPENQODEX_HOME/tools` (default `~/.openqodex/tools`) is used. With `allowInstall: true`, a missing tool is installed from the pinned table and checked against its sha256, by the package's own `openqodex` command in a separate process; `installBudgetMs` is how long to wait for it, and `null` waits until it is done. With `allowInstall: false`, a missing tool is reported as not installed.

`loadToolchain()` returns the pinned scanner table, `{ schema: 1, tools }`: per tool, its version, how it installs and, for a release download, the URL and sha256 for each platform. A tool installed from a registry (uv, gem) is pinned by a lock file of sha256 hashes in `locks/`.

`toolchainHash()` returns the sha256 of the table and every lock file as shipped. It changes when a pin changes and only then, so it works as a cache key for a tools folder.

## graph

`buildGraph(args)` reads the code of a git work tree and returns `Promise<Graph>`: the definitions, calls and imports of its TypeScript, JavaScript, Python, Go and Ruby files, and how they connect. `args` is a `BuildArgs`:

- `repoRoot`: the folder to read. It must be a git work tree, because the list of files comes from git.
- `files` (optional): paths to read first, such as the changed files, so a cut never leaves them out.
- `only` (optional): the only paths the graph may read.
- `budgetMs`, `maxFiles`, `maxFileBytes`, `maxHeapMb` (optional): the limits, by default 10 seconds, 4,000 parses, 512 KB per file and 1,536 MB.
- `base` (optional): `{ sha, files }`. Each changed file's version at `sha` is parsed too, so a symbol the change removed is known with the callers it leaves behind.
- `store` (optional): where facts are kept between builds. Leave it out to keep nothing.
- `onProgress` (optional): called with one line per step.

`detectImpact(graph, change)` returns the blast radius of a change as an `ImpactSummary`. `change` needs `files` (the changed files) and `coverage` (the changed lines). The summary lists the symbols the change touches or removes, their callers and callees with how certain each link is, the files that import a changed file, what the graph could not see, and a risk level.

`extractFacts(lang, text)` parses the text of one file and returns `Promise<FileFacts | null>`: its definitions, calls and imports, extracted the same way a build does it. `lang` is one of `typescript`, `tsx`, `javascript`, `python`, `go` and `ruby`. It returns `null` when the parse takes longer than two seconds.

`writePacket({ root, repoRoot, graph, impact, baseSha, secrets })` writes the graph's view of a change as files under `.openqodex-review/graph/` in `root`, for a reviewer to read, and returns `Promise<{ dir, files }>`. Every secret in `secrets` is redacted from every file. It throws `PacketCollision` when `root` already holds `.openqodex-review`, and `PacketLeak` when a secret is still found in a written file.

## lenses

A lens is a named bug pattern, one markdown file, that the review hands to the reviewer when a change matches it. The package ships 48.

- `loadLensCatalog(dir)` returns every lens as a `Lens`. `dir` is optional; without it the lenses come from the installed package.
- `defaultLensDir()` returns the folder of the installed package's lenses.
- `selectLensesForDiff({ diff, files, catalog, covered })` returns the lenses that match a change, at most four, most specific first, as `SelectedLens[]`. `diff` is the change's unified diff, `files` the changed paths, `catalog` the lenses to choose from. `covered` (optional) is `(token, file) => boolean`: a lens stands down when a scanner rule that ran already checks what it asks for.
- `selectLenses(change, dir, covered)` does the same from a `Change`, with the lenses in `dir` or the installed package's.

## Config

`parseConfig(source, file, options)` parses the text of a `.openqodex/config.yaml` and returns `{ config, warnings }`. `file` (optional) names the file in messages. It throws when the text is not valid YAML or breaks the schema; the message names the file and, for a wrong key, the key. The keys are documented in `config`.

`loadConfig(repoRoot, path, options)` reads the config of a repository and returns a `LoadedConfig`: `{ config, path, warnings }`. `path` (optional) names the file to read; without it, `.openqodex/config.yaml` is read, or `.openqodex.yaml` when only that one exists. With no file at all, `config` holds the defaults and `path` is `null`.

## render

Each renderer takes a `Report`, the shape `report.json` holds, and returns a string.

- `renderMarkdown(report)`: the markdown report, as `report.md`.
- `renderSarif(report)`: SARIF 2.1.0, as `report.sarif`.
- `renderJson(report)`: the JSON report, as `report.json`.
- `renderReview(report, { format, color })`: the review as the command prints it. `format` is `terminal` or `markdown`; `color` (optional) adds terminal colours.

## Types

The library exports the types its functions take and return. The finding, report and completion types are `Report`, `ReportFinding`, `Verdict`, `CompletionRecord`, `ReviewerRecord`, `StaticFinding`, `Candidate`, `Severity` and `Category`. The others are `ScannerSource`, `ScannerRunSummary`, `ScanResult`, `RunScannersResult`, `ResolveTool`, `ToolResolution`, `Toolchain`, `Recipe`, `DiffCoverage`, `Change`, `ChangedFile`, `Config`, `LoadedConfig`, `ParseOptions`, `Lens`, `SelectedLens`, `ImpactSummary`, `Graph`, `BuildArgs`, `FileFacts` and `Lang`.
