---
"openqodex": minor
---

The code graph reads Express, React, Next.js, FastAPI and Go net/http code: each route with its full path and the function that handles it, the routers and middleware in front of it, components and the components they render, hooks, and the tests that request a route or render a component. A route whose handler is missing, wrapped or computed stays listed with a note saying why, and two applications in one repository never share routes.
What a framework plugin cannot read is recorded as an unknown with its reason, never left out: a computed path or prefix, a name a parameter or local shadows, a list longer than the plugin reads, a test request it cannot compare with a route, and a budget it reached.
The review brief lists what these plugins find in the same framework tables as Django and Rails: the routes that reach the changed code, routes left without a handler, and the tests that call it, request its route or render it.
The framework facts cached under `.openqodex/graph/` keep a string from your code only where a plugin reads one (a route path, a prefix, a method, a request path), applied to the whole value a concatenation makes, with key-shaped tokens redacted and nothing over 512 characters kept, so a key, a header or any other literal in the code is not copied there.
