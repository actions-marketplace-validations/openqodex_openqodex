// The Django plugin (being built): urls and views, models and fields,
// migrations, templates and template tags, management commands, signals,
// settings keys, tests to code.
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";

export const django: FrameworkPlugin<FrameworkFactBase> = {
  id: "django",
  version: 1,
  supportedVersions: "Django 3.2 to 5.1",
  languages: ["python"],
  inputs: { paths: [], dependencies: { python: ["django"] } },
  wants: () => false,
  facts: () => [],
  isFact: (v): v is FrameworkFactBase => typeof v === "object" && v !== null,
  detect: () => [],
  resolve: () => ({ roles: [], entities: [], edges: [], unknowns: [] }),
  capabilities: () => ({ plugin: "django", version: 1, supportedVersions: "Django 3.2 to 5.1", rules: [], negativeControls: [], sampleApps: [] }),
};
