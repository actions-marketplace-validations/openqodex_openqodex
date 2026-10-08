// The React plugin (being built): components, hooks, which component
// renders which, component render tests.
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";

export const react: FrameworkPlugin<FrameworkFactBase> = {
  id: "react",
  version: 1,
  supportedVersions: "React 16.8 to 19",
  languages: ["javascript", "typescript", "tsx"],
  inputs: { paths: [], dependencies: { npm: ["react"] } },
  wants: () => false,
  facts: () => [],
  isFact: (v): v is FrameworkFactBase => typeof v === "object" && v !== null,
  detect: () => [],
  resolve: () => ({ roles: [], entities: [], edges: [], unknowns: [] }),
  capabilities: () => ({ plugin: "react", version: 1, supportedVersions: "React 16.8 to 19", rules: [], negativeControls: [], sampleApps: [] }),
};
