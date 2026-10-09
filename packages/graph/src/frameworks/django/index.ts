// The Django plugin: urls and views, models and fields, migrations,
// templates and template tags, management commands, signals, settings
// keys, and the links from tests to code (frameworks/README.md).
import type { FrameworkPlugin } from "../plugin.js";
import { djangoFacts, isDjangoFact, wantsDjango } from "./facts.js";
import type { DjangoFact } from "./facts.js";
import { RULES, detectDjango, resolveDjango } from "./resolve.js";

// 2: URL list statements in order, replacement and branches (facts changed).
// 3: a router's trailing_slash option.
// 4: what the facts could not read is a fact of its own (kind "unread").
// 5: 1-based columns, as the language facts.
// 6: every class attribute built by a named call is a field candidate.
// 7: a literal is kept only where resolve reads its value.
// 8: a kept literal is bounded, with key-shaped text redacted.
// 9: a literal over the bound is not kept, and a redacted run is named by its hash.
const VERSION = 9;
const SUPPORTED = "Django 3.2 to 5.1, Django REST framework routers 3.x";

// Corpus case names are relative to packages/graph/corpus/frameworks/django/.

export const django: FrameworkPlugin<DjangoFact> = {
  id: "django",
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["python"],
  inputs: {
    // Templates are found by path, and manage.py marks a project root.
    paths: [/(^|\/)templates\//, /(^|\/)manage\.py$/, /(^|\/)management\/commands\/[^/]+\.py$/, /(^|\/)migrations\/[^/]+\.py$/],
    dependencies: { python: ["django", "djangorestframework"] },
  },
  wants: (source) => wantsDjango(source),
  facts: (root) => djangoFacts(root),
  isFact: isDjangoFact,
  detect: detectDjango,
  resolve: resolveDjango,
  capabilities: () => ({
    plugin: "django",
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: RULES.urls.id,
        version: RULES.urls.version,
        description: "Each path, re_path or url entry of a urlpatterns list reached from ROOT_URLCONF is a registration bound to its view through the resolver; a class view's HTTP methods and a class instance's __call__ are possible handlers.",
        emits: ["registration", "handles", "route_handler", "route_table"],
        fixtures: { positive: ["blog-app", "real-code-shapes", "unread-statements"], aliased: ["urls-aliased-import", "rebound-by-binding"], unrelatedSameName: ["urls-unrelated-path"], dynamic: ["urls-dynamic", "computed-prefix", "unread-statements"], metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.include.id,
        version: RULES.include.version,
        description: "include() of a literal module path composes the included table under the entry's prefix, to a depth of 8, with namespaces carried.",
        emits: ["mounts", "registration"],
        fixtures: { positive: ["blog-app", "wagtail-shapes"], aliased: ["urls-aliased-import"], unrelatedSameName: ["urls-unrelated-path"], dynamic: ["urls-dynamic", "computed-prefix"], metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.drf.id,
        version: RULES.drf.version,
        description: "A Django REST framework router's register() calls become list and detail registrations under the prefix the router is included at.",
        emits: ["registration", "handles"],
        fixtures: { positive: ["drf-router"], aliased: { none: "a router is a value of the module, not an import that can be aliased at the call" }, unrelatedSameName: ["drf-router"], dynamic: ["drf-router"], metadataEdit: { none: "covered by the urlpatterns rule's dependency case" } },
      },
      {
        id: RULES.templates.id,
        version: RULES.templates.version,
        description: "A literal template name in render(), a template loader call or template_name is matched to files under templates folders: one match is likely, several are possible, none is a gap.",
        emits: ["renders", "template"],
        fixtures: { positive: ["templates"], aliased: ["templates"], unrelatedSameName: ["templates"], dynamic: ["templates"], metadataEdit: ["template-added"] },
      },
      {
        id: RULES.models.id,
        version: RULES.models.version,
        description: "A class whose base binds to django.db.models.Model, or to such a class, is a model with its fields, its relations and its table.",
        emits: ["model", "declares_field", "uses_type", "maps_to", "model_field", "table"],
        fixtures: { positive: ["models-migrations", "real-code-shapes", "field-classes"], aliased: ["models-migrations"], unrelatedSameName: ["models-migrations", "field-helper"], dynamic: { none: "a model base is a name, never a computed value" }, metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.migrations.id,
        version: RULES.migrations.version,
        description: "A Migration class under migrations/ is a migration; each operation names its model in the same app folder.",
        emits: ["migration", "changes_schema", "migration_operation", "runs"],
        fixtures: { positive: ["models-migrations"], aliased: { none: "operations are read inside a Migration class whose base binds to Django" }, unrelatedSameName: ["models-migrations"], dynamic: ["models-migrations"], metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.commands.id,
        version: RULES.commands.version,
        description: "A Command class under management/commands/<name>.py is the command <name>, run by its handle method.",
        emits: ["command", "runs"],
        fixtures: { positive: ["commands-signals-tags"], aliased: { none: "the command name comes from the file path" }, unrelatedSameName: ["commands-signals-tags"], dynamic: { none: "the command name comes from the file path" }, metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.tags.id,
        version: RULES.tags.version,
        description: "A function decorated by a template.Library() value's simple_tag, filter, tag or inclusion_tag is a template tag; an inclusion tag renders its template.",
        emits: ["template_tag", "renders"],
        fixtures: { positive: ["commands-signals-tags"], aliased: ["commands-signals-tags"], unrelatedSameName: ["commands-signals-tags"], dynamic: { none: "a decorator is a name, never a computed value" }, metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.signals.id,
        version: RULES.signals.version,
        description: "@receiver(signal) and signal.connect(handler) connect a Django signal or a Signal() of the repository to its receiver.",
        emits: ["schedules", "signal", "signal_receiver"],
        fixtures: { positive: ["commands-signals-tags"], aliased: ["commands-signals-tags"], unrelatedSameName: ["commands-signals-tags"], dynamic: ["unread-statements"], metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.settings.id,
        version: RULES.settings.version,
        description: "Upper-case assignments of an application's settings module are config keys; settings.X reads through django.conf are links to them, never their values.",
        emits: ["config_key", "defines_config", "reads_config", "config"],
        fixtures: { positive: ["settings-keys"], aliased: ["settings-keys"], unrelatedSameName: ["settings-keys"], dynamic: ["unread-statements"], metadataEdit: ["dependency-added"] },
      },
      {
        id: RULES.tests.id,
        version: RULES.tests.version,
        description: "Test files and their TestCase classes and test functions are tests; a client request whose literal path matches a route, or a reverse() of a route name, links the test to the route.",
        emits: ["tests", "test"],
        fixtures: { positive: ["blog-app", "wagtail-shapes"], aliased: ["urls-aliased-import"], unrelatedSameName: ["urls-unrelated-path"], dynamic: ["urls-dynamic", "computed-prefix"], metadataEdit: ["dependency-added"] },
      },
    ],
    negativeControls: ["urls-unrelated-path", "no-dependency", "two-apps"],
    sampleApps: ["packages/graph/test/frameworks-django.test.ts"],
  }),
};
