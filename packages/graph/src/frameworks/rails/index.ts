// The Rails plugin (being built): routes to controllers and actions, models
// and associations, migrations, views and partials, jobs, mailers, config,
// tests to code.
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";

export const rails: FrameworkPlugin<FrameworkFactBase> = {
  id: "rails",
  version: 1,
  supportedVersions: "Rails 6.1 to 8.0",
  languages: ["ruby"],
  inputs: { paths: [], dependencies: { gems: ["rails"] } },
  wants: () => false,
  facts: () => [],
  isFact: (v): v is FrameworkFactBase => typeof v === "object" && v !== null,
  detect: () => [],
  resolve: () => ({ roles: [], entities: [], edges: [], unknowns: [] }),
  capabilities: () => ({ plugin: "rails", version: 1, supportedVersions: "Rails 6.1 to 8.0", rules: [], negativeControls: [], sampleApps: [] }),
};
