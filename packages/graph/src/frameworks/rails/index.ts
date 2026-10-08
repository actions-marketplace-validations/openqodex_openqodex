// The Rails plugin: routes to controllers and actions, controller
// callbacks, views and partials, models with their associations and
// tables, migrations, jobs, mailers, config keys and the links from tests
// to code. Facts are read from each Ruby file's parse tree (facts.ts);
// applications are detected from the Gemfile and the application markers
// (world.ts); routes expand before any handler is looked up (routes.ts);
// everything else resolves through the PluginIndex (resolve.ts).
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { RailsFact } from "./facts.js";
import { isRailsFact, railsFacts, wantsRails } from "./facts.js";
import { RULES, resolveRails } from "./resolve.js";
import { PLUGIN, VERSION, detectApps } from "./world.js";

const SUPPORTED = "Rails 6.1 to 8.0";
const NO_IMPORT = "Ruby has no import to alias: constants are found by the autoload convention";
const NO_DYNAMIC = "the rule reads a file's place by its path, which is never computed";

export const SAMPLE_APP = "packages/graph/test/frameworks-rails.test.ts";

export function railsCapabilities(): CapabilityReport {
  return {
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: RULES.application,
        version: 1,
        description: "Detects a Rails application from rails in a Gemfile plus config/application.rb, a config/routes.rb draw block or bin/rails, and an engine from a Rails::Engine class.",
        emits: ["route_table"],
        fixtures: { positive: ["routes-sample", "engine-mount"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-no-rails-gem", "neg-no-marker"], dynamic: { none: NO_DYNAMIC }, metadataEdit: ["routes-edit"] },
      },
      {
        id: RULES.routes,
        version: 1,
        description: "Reads get, post, put, patch, delete, match, root, namespace, scope, controller and draw calls in config/routes.rb and config/routes/ into registrations with composed paths, controllers, actions and Rails names.",
        emits: ["registration", "route_table"],
        fixtures: { positive: ["routes-sample", "namespace-scope", "scope-defaults"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-outside-draw", "draw-outside-route-files"], dynamic: ["dynamic-values"], metadataEdit: ["routes-edit"] },
      },
      {
        id: RULES.resources,
        version: 1,
        description: "Expands resources and resource from the declaration and its only and except options into seven or six registrations, with nested, member, collection and shallow routes.",
        emits: ["registration"],
        fixtures: { positive: ["resources-only-except"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-outside-draw"], dynamic: ["dynamic-values"], metadataEdit: ["routes-edit"] },
      },
      {
        id: RULES.handler,
        version: 1,
        description: "Binds a registration to its controller action by the app/controllers path convention, and keeps a registration whose action is missing with a gap.",
        emits: ["handles", "route_handler"],
        fixtures: { positive: ["routes-sample", "missing-action"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-unrelated-controller"], dynamic: ["dynamic-values"], metadataEdit: ["missing-action"] },
      },
      {
        id: RULES.mount,
        version: 1,
        description: "Links a mount of an engine to the engine's routes; the host and the engine stay two applications.",
        emits: ["mounts", "registration"],
        fixtures: { positive: ["engine-mount"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["engine-mount"], dynamic: ["dynamic-values"], metadataEdit: { none: "a mount has no metadata beyond its routes file, which routes-edit covers" } },
      },
      {
        id: RULES.actions,
        version: 1,
        description: "Gives the route handler role to the public methods of controller classes under app/controllers.",
        emits: ["route_handler"],
        fixtures: { positive: ["routes-sample"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-unrelated-controller"], dynamic: { none: NO_DYNAMIC }, metadataEdit: { none: "a controller's actions are its own source" } },
      },
      {
        id: RULES.callbacks,
        version: 1,
        description: "Links a controller to the methods its before, around and after action callbacks name, in order, and to the definitions in its subclasses when it defines none.",
        emits: ["applies_middleware"],
        fixtures: { positive: ["routes-sample", "callback-in-subclass"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-unrelated-controller"], dynamic: ["dynamic-values"], metadataEdit: { none: "callbacks are declared in the controller's own source" } },
      },
      {
        id: RULES.views,
        version: 1,
        description: "Links an action or mailer method to the views it renders: render with a literal name, template, action or partial, and the implicit view of an action.",
        emits: ["renders", "template"],
        fixtures: { positive: ["views"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["views"], dynamic: ["dynamic-values"], metadataEdit: ["view-added"] },
      },
      {
        id: RULES.models,
        version: 1,
        description: "Gives the model role to classes under app/models based on ApplicationRecord or ActiveRecord::Base, and maps each to its table.",
        emits: ["model", "maps_to", "table"],
        fixtures: { positive: ["models-migrations"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-unrelated-controller"], dynamic: ["dynamic-values"], metadataEdit: { none: "a model's table is declared in its own source" } },
      },
      {
        id: RULES.associations,
        version: 1,
        description: "Links a model to the models its has_many, has_one, belongs_to and has_and_belongs_to_many associations name, with class_name honoured and through associations followed to their source.",
        emits: ["uses_type"],
        fixtures: { positive: ["models-migrations", "association-through"], aliased: { none: NO_IMPORT }, unrelatedSameName: { none: "an association is read only inside a model class" }, dynamic: ["dynamic-values"], metadataEdit: { none: "associations are declared in the model's own source" } },
      },
      {
        id: RULES.migrations,
        version: 1,
        description: "Gives the migration role to files under db/migrate and links each schema operation to the table it names and the model mapped to it.",
        emits: ["migration", "migration_operation", "changes_schema", "table"],
        fixtures: { positive: ["models-migrations"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-outside-draw"], dynamic: ["dynamic-values"], metadataEdit: ["models-migrations"] },
      },
      {
        id: RULES.jobs,
        version: 1,
        description: "Gives the job role to ActiveJob and Sidekiq classes under app/jobs and app/workers and links each perform_later or perform_async site to the job's perform method.",
        emits: ["job", "enqueues"],
        fixtures: { positive: ["jobs-mailers"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["jobs-mailers"], dynamic: { none: "an enqueue is read only on a constant receiver" }, metadataEdit: { none: "a job is declared in its own source" } },
      },
      {
        id: RULES.mailers,
        version: 1,
        description: "Gives the mailer role to classes under app/mailers, links deliver_later and deliver_now sites to the mailer method and each mailer method to its view.",
        emits: ["mailer", "enqueues", "renders"],
        fixtures: { positive: ["jobs-mailers"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["jobs-mailers"], dynamic: { none: "a delivery is read only on a constant receiver" }, metadataEdit: { none: "a mailer is declared in its own source" } },
      },
      {
        id: RULES.config,
        version: 1,
        description: "Reads config keys assigned in config/application.rb, config/environments and config/initializers, and Rails config and ENV reads, by key and never by value.",
        emits: ["config_key", "defines_config", "reads_config"],
        fixtures: { positive: ["config"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["config"], dynamic: ["dynamic-values"], metadataEdit: ["config"] },
      },
      {
        id: RULES.tests,
        version: 1,
        description: "Gives the test role to spec files (with an RSpec gem) and test files, and links them to the classes they describe, the routes their literal requests match and the routes their URL helpers name.",
        emits: ["test", "tests"],
        fixtures: { positive: ["tests-links"], aliased: { none: NO_IMPORT }, unrelatedSameName: ["neg-outside-draw"], dynamic: ["dynamic-values"], metadataEdit: { none: "test links come from the test's own source and the routes, which routes-edit covers" } },
      },
    ],
    negativeControls: ["neg-outside-draw", "neg-no-rails-gem", "neg-unrelated-controller", "neg-no-marker"],
    sampleApps: [SAMPLE_APP],
  };
}

export const rails: FrameworkPlugin<RailsFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["ruby"],
  inputs: {
    // Presence only: route files, the markers, view files and migrations.
    paths: [/(^|\/)config\/routes(\.rb$|\/)/, /(^|\/)config\/application\.rb$/, /(^|\/)bin\/rails$/, /(^|\/)app\/views\//, /(^|\/)db\/migrate\//, /(^|\/)Gemfile$/, /(^|\/)lib\/[^/]+\/engine\.rb$/],
    dependencies: { gems: ["rails", "rspec-rails", "rspec", "rspec-core", "sidekiq"] },
  },
  wants: (source) => wantsRails(source),
  facts: (root) => railsFacts(root),
  isFact: isRailsFact,
  detect: (index) => detectApps(index).detections,
  resolve: (index, apps) => resolveRails(index, apps),
  capabilities: railsCapabilities,
};
