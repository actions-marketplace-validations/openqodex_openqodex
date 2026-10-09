---
"openqodex": minor
---

The code graph reads Express, React, Next.js, FastAPI and Go net/http code: each route with its full path and the function that handles it, the routers and middleware in front of it, components and the components they render, hooks, and the tests that request a route or render a component. A route whose handler is missing, wrapped or computed stays listed with a note saying why, and two applications in one repository never share routes.
What a framework plugin cannot read is recorded as an unknown with its reason, never left out: a computed path or prefix, a name a parameter or local shadows, a list longer than the plugin reads, a test request it cannot compare with a route, and a budget it reached.
