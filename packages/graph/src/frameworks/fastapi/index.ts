// The FastAPI plugin (being built): decorated routes to handlers, routers
// and include_router prefixes, dependencies, Pydantic models, TestClient
// requests.
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";

export const fastapi: FrameworkPlugin<FrameworkFactBase> = {
  id: "fastapi",
  version: 1,
  supportedVersions: "FastAPI 0.100 and later",
  languages: ["python"],
  inputs: { paths: [], dependencies: { python: ["fastapi"] } },
  wants: () => false,
  facts: () => [],
  isFact: (v): v is FrameworkFactBase => typeof v === "object" && v !== null,
  detect: () => [],
  resolve: () => ({ roles: [], entities: [], edges: [], unknowns: [] }),
  capabilities: () => ({ plugin: "fastapi", version: 1, supportedVersions: "FastAPI 0.100 and later", rules: [], negativeControls: [], sampleApps: [] }),
};
