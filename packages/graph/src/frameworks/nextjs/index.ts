// The Next.js plugin (being built): app and pages routers, routes from the
// file tree, layouts, route handlers, API routes, server actions,
// middleware.
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";

export const nextjs: FrameworkPlugin<FrameworkFactBase> = {
  id: "nextjs",
  version: 1,
  supportedVersions: "Next.js 13.4 to 15",
  languages: ["javascript", "typescript", "tsx"],
  inputs: { paths: [], dependencies: { npm: ["next"] } },
  wants: () => false,
  facts: () => [],
  isFact: (v): v is FrameworkFactBase => typeof v === "object" && v !== null,
  detect: () => [],
  resolve: () => ({ roles: [], entities: [], edges: [], unknowns: [] }),
  capabilities: () => ({ plugin: "nextjs", version: 1, supportedVersions: "Next.js 13.4 to 15", rules: [], negativeControls: [], sampleApps: [] }),
};
