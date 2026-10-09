# Framework plugins

A framework plugin turns one framework's conventions into graph facts with proof: route registrations and their handlers, models and fields, migrations, templates, components, hooks, jobs, commands, signals, config keys, and the links from tests to code.
The contract is `plugin.ts`. This page says how a plugin is written, registered and proved.

## The rules every plugin obeys

- API identity. A registration counts only when its callee or receiver binds to the framework's own import, or the file has the framework's role (`config/routes.rb` inside a `routes.draw` block). A dependency in a manifest enables a rule. It never proves a receiver: `app.get("/x", h)` on an object that is not an Express app is not a route.
- Application scope. Every registration, job and config key carries the application it belongs to. Two applications in one repository never merge their routes.
- Literal evidence only. A route path, template name, config key or job name that is computed becomes an unknown with cause `dynamic`, never an edge.
- Registrations stay apart from handlers. A registration whose handler is missing, computed or outside the repository is still listed, with the handler's status and an unknown that says why. Deleting an action never deletes its route.
- Tests are never called coverage. A test link says what the test does with the target: it calls it, requests its route, names its route, or names the class it is about.
- Overflow is a gap. Every cap emits a scoped unknown when it stops.
- Failure removes output. A plugin that throws contributes nothing to the build, and the build says so in its reasons.
- Nothing from the repository runs. Settings, routes and config files are parsed, never imported or executed.
- Bounded work on hostile input. No regular expression is ever built from repository text or run on it: a route pattern becomes tokens read by a linear scan and a request path is matched by hand under a step budget. Every regex a plugin keeps runs on paths or short tokens and has no nested or overlapping repetition. A plugin caps what can multiply (Django includes, Rails nested resources: 10,000 registrations per application) and emits a gap when it stops. The core adds its own caps: no plugin reads a source over 1 MiB (`facts.ts`), one plugin keeps at most 2,000 facts per file, 20,000 entities and 100,000 edges per application (`stage.ts`). Each plugin ships a test that runs its facts and its resolve on a hostile file just under 1 MiB in under a second.
- Repository text reaches the reviewer only quoted. The brief prints every route path, route name, template name and note inside a table cell, on one line, cut to 120 characters (`render.ts`); a plugin's notes are short plain sentences.

## How a plugin is written

A plugin is one folder, `frameworks/<id>/`, whose `index.ts` exports one `FrameworkPlugin` value. It works in two steps, kept apart like the rest of the graph.

1. `facts(root, lang)` reads one file's parse tree and returns plain JSON facts, each with a `kind`, a `line` and a `column`. Facts are context-free: they never read another file, the file's own path or the environment. They are cached with the file's language facts under the file's content, the plugin's `version` and the plugin API version, in `FileFacts.frameworks[<id>]`. `wants(source, lang)` is a cheap text test that skips files the plugin has nothing to read in. `isFact(v)` checks one cached fact's shape, because facts are read back from disk. A plugin that walks the whole tree also gives `reader(root, lang)`: the same facts, read as one reader of the walk the plugins share (`shared/walk.ts`), so each file is walked once for every such plugin rather than once per plugin. Its `visitor` is told each named node with its type, its field and its ancestors, and when the walk leaves it; `finish` returns the facts. `facts` stays, as the reader walking alone.
2. `detect(index)` and `resolve(index, apps)` run after symbol resolution on every build. They read only through `PluginIndex`: the capture's paths, the plugin's own facts per file, the language facts, the symbols of a file, what a dotted name means at the top level of a file (`lookup`), which file a module specifier names (`module`), the call edges out of a symbol, the project of a file and the declared dependencies. `detect` returns one `Detection` per application instance, each with the evidence that proved it. `resolve` returns roles, entities, edges and unknowns.

What a plugin emits:

| Output | What it is | Example |
|---|---|---|
| `RoleAssignment` | a role on a symbol or a file | `blog/views.py#post_list` is a `route_handler`; `blog/models.py#Post` is a `model` |
| `Registration` | one route registration site, with its methods, its composed pattern, its name, the mounts that composed it and its handler's status | `GET blog/<int:pk>/` named `post-detail`, handler `views.post_detail`, bound |
| other `Entity` | a template, command, job, signal, config key, model field, migration operation or table | `fw:django:template:<app>:blog/post_list.html` |
| `FrameworkEdge` | `handles`, `mounts`, `renders`, `tests`, `declares_field`, `changes_schema`, `maps_to`, `uses_type`, `applies_middleware`, `schedules`, `enqueues`, `reads_config`, `defines_config`, `runs` | registration `handles` `post_detail`; `post_detail` `renders` `blog/post_detail.html` |
| `FrameworkUnknown` | what the plugin could not see, with its cause, scope and the relations it can hide | a computed `include()` path: cause `dynamic`, affects `mounts` and `handles` |

Every edge and role carries a `FrameworkEvidence` record: the evidence kind, the tier, the site it was read at, what proved it (`via`), the premises it rests on, the rule id and version, and a note when the tier is below certain. `validateFrameworkEvidence` refuses a certain record whose kind rests on a naming convention: a controller found by its file path, an implicit view and a table found by pluralisation are likely at most.

Ids: entities use `entityId(plugin, app, kind, key)`, applications use `appId(plugin, file, line)`. Neither can collide with a symbol id (which holds `#`) or a file path.

## How a plugin is registered

Add one import and one entry to `PLUGINS` in `registry.ts`, in id order. Nothing else names a plugin: the build, the brief and the query layer read every plugin through the registry. A plugin added, removed or bumped changes `pluginsKey()`, which is part of every cached facts key, so every file's facts are read again.

Bump `version` whenever the facts or the resolve rules change shape or meaning.
`plugin.ts` only grows: a field or a union member is appended, never removed or narrowed, and a change bumps `PLUGIN_API_VERSION`. A builder who needs a change to it writes the request in `REQUESTS.md` beside this page.

## How a plugin is proved

- Corpus cases. Each rule in `capabilities()` names its cases under `packages/graph/corpus/frameworks/<id>/`: a positive case, an aliased-import case, an unrelated same-name case, a dynamic case and a metadata-edit case. A rule whose shape has no such case (a path convention has no import to alias) names the reason instead. Each case is a real two-commit repository like the rest of the corpus, with a `frameworks` section in its `expected.json` listing the registrations, edges, roles and unknowns it must produce.
- Negative controls. `capabilities().negativeControls` names the cases where the plugin must emit no registration and no edge: a file that looks like a route table and is not one, a same-named function from another library, the framework's name in a manifest with no application.
- A sample application. `capabilities().sampleApps` names a test that builds a small real application in a temporary folder, runs the whole graph build, and checks every column of the plugin's table: routes and handlers, templates, models and migrations, tests to code, and the lines the review brief prints for a change to a handler.
- `packages/graph/test/frameworks.test.ts` checks every registered plugin: each rule names its fixture cases and each named case exists, every evidence record passes `validateFrameworkEvidence`, and a plugin that throws contributes nothing.

## What the review and the query layer read

The build runs every plugin after symbol resolution and keeps the result on the graph as `graph.frameworks` (`layer.ts`). The brief and the query layer read it only through that object: which registrations a symbol handles or is reached from, which templates it renders, which tests reference, call or may request it, which migrations change a model's table, and what the plugins could not see.
