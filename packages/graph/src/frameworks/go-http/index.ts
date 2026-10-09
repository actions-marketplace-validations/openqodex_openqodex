// The Go net/http plugin (PLAN.md 3.2.3, the Go net/http row): muxes made by
// `http.NewServeMux()` and each project's default mux, the routes registered
// on them with `Handle` and `HandleFunc` (Go 1.22 method and wildcard
// patterns), their handlers (functions, method values, `http.HandlerFunc`
// conversions, types with a ServeHTTP method), the middleware wrapped around
// a handler, muxes mounted under others (directly or through
// `http.StripPrefix`), the servers that serve a mux, go test functions and
// the httptest requests that may reach each route. See resolve.ts for the
// rules.
import type { CapabilityReport, FrameworkPlugin } from "../plugin.js";
import type { GoHttpFact } from "./facts.js";
import { isGoHttpFact, readFacts, wants } from "./facts.js";
import { analyse, PLUGIN, RULE_VERSION } from "./resolve.js";

// 2: a local name carries the declaration it reads (block identity).
// 3: a read limit marks what it cut, and a call or a literal counts what it left out.
// 4: a receiver typed as a mux (field, call result) is listed; what cannot be bound is said.
export const VERSION = 5;
const SUPPORTED = "Go 1.22 and later net/http";

const app = "go-http-app";
const mount = "go-http-mount";
const meta = "go-http-metadata-edit";
const control = "go-http-not-net-http";

export const goHttp: FrameworkPlugin<GoHttpFact> = {
  id: PLUGIN,
  version: VERSION,
  supportedVersions: SUPPORTED,
  languages: ["go"],
  inputs: { paths: [], dependencies: {} },
  wants: (source) => wants(source),
  facts: (root) => readFacts(root),
  isFact: (v): v is GoHttpFact => isGoHttpFact(v),
  detect: (index) => analyse(index).apps,
  resolve: (index) => analyse(index).output,
  capabilities: (): CapabilityReport => ({
    plugin: PLUGIN,
    version: VERSION,
    supportedVersions: SUPPORTED,
    rules: [
      {
        id: "go-http-route",
        version: RULE_VERSION,
        description: "A route registered with Handle or HandleFunc on a mux made by net/http or on the default mux, with its method and pattern, and its handler bound by the handler's own binding, kept when the handler is missing, wrapped, inline or computed.",
        emits: ["registration", "handles", "route_handler"],
        fixtures: { positive: [app], aliased: [mount], unrelatedSameName: [app, control], dynamic: [app], metadataEdit: [meta] },
      },
      {
        id: "go-http-mount",
        version: RULE_VERSION,
        description: "A mux registered as the handler of another mux, directly or through http.StripPrefix, with its routes composed into the outer mux under the stripped prefix.",
        emits: ["mounts"],
        fixtures: { positive: [mount], aliased: [mount], unrelatedSameName: [control], dynamic: [mount], metadataEdit: [meta] },
      },
      {
        id: "go-http-middleware",
        version: RULE_VERSION,
        description: "A function of the repository that takes a handler and wraps the handler of a route, outermost first; the route's handler is then the value the wrapper returns and is not bound.",
        emits: ["applies_middleware", "middleware"],
        fixtures: {
          positive: [app],
          aliased: [mount],
          unrelatedSameName: [control],
          dynamic: { none: "a wrapper is a call of a named function; a computed wrapper leaves the handler unresolved, covered by the route rule's dynamic case" },
          metadataEdit: { none: "a wrapper binds through the same lookup as a handler; the route rule's metadata-edit case proves that lookup across a go.mod change" },
        },
      },
      {
        id: "go-http-test-request",
        version: RULE_VERSION,
        description: "An httptest.NewRequest in a _test.go file whose literal method and path match a route of the same project: likely when the matching routes lie on one mux, possible when they lie on several.",
        emits: ["tests"],
        fixtures: {
          positive: [app],
          aliased: [mount],
          unrelatedSameName: [control],
          dynamic: [mount],
          metadataEdit: { none: "a request is matched against the routes the route rule lists; the route rule's metadata-edit case covers a go.mod change" },
        },
      },
      {
        id: "go-http-test-function",
        version: RULE_VERSION,
        description: "A function TestX(t *testing.T) in a _test.go file of a project that serves net/http is a test; the calls it makes become direct-call test links.",
        emits: ["test"],
        fixtures: {
          positive: [app],
          aliased: [mount],
          unrelatedSameName: [control],
          dynamic: { none: "a test function is a declaration, never a computed value" },
          metadataEdit: { none: "the testing package is the standard library, which no go.mod declares" },
        },
      },
    ],
    negativeControls: [control],
    sampleApps: ["packages/graph/src/frameworks/go-http/go-http.test.ts"],
  }),
};
