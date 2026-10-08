// The Go net/http plugin (being built): muxes and their handler
// registrations, handler functions and http.Handler types, middleware
// wrappers, httptest requests.
import type { FrameworkFactBase, FrameworkPlugin } from "../plugin.js";

export const goHttp: FrameworkPlugin<FrameworkFactBase> = {
  id: "go-http",
  version: 1,
  supportedVersions: "Go 1.22 and later net/http",
  languages: ["go"],
  inputs: { paths: [], dependencies: {} },
  wants: () => false,
  facts: () => [],
  isFact: (v): v is FrameworkFactBase => typeof v === "object" && v !== null,
  detect: () => [],
  resolve: () => ({ roles: [], entities: [], edges: [], unknowns: [] }),
  capabilities: () => ({ plugin: "go-http", version: 1, supportedVersions: "Go 1.22 and later net/http", rules: [], negativeControls: [], sampleApps: [] }),
};
