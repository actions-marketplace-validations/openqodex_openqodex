---
name: ssrf-server-side-fetch
description: Server-side HTTP request whose host or URL comes from user input
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.mjs"
    - "*.py"
    - "*.rb"
    - "*.go"
    - "*.java"
    - "*.kt"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.mjs"
    - "**/*.py"
    - "**/*.rb"
    - "**/*.go"
    - "**/*.java"
    - "**/*.kt"
  hunk_regex: "fetch\\(|axios\\.|http\\.get|requests\\.(get|post)|urllib|HttpClient|RestTemplate|WebClient|Net::HTTP|http\\.NewRequest"
security: true
confidence_floor: 0.75
---

The server makes an HTTP request, and the host or the whole URL comes
from a request field, a header, or a value a user stored earlier
(a webhook target, an avatar URL, an "import from URL" box, a
provider's base URL held in a settings row). The attacker then chooses
where your server connects. Inside a cloud network that reaches the
instance metadata endpoint (`169.254.169.254`), internal admin services
on private ranges, and anything listening on localhost, none of which
is reachable from the internet, which is exactly why they are
unauthenticated.

What to check before flagging:

- Where the host comes from. Trace the value back: a request body or
  query field, a header, or a stored row a user controls all count. A
  constant base URL with only a path segment from input does not.
- Whether the host is allow-listed against an explicit set, and whether
  the check runs on the URL that is finally fetched rather than on a
  copy parsed earlier.
- Whether the scheme is pinned to http or https, so `file://`,
  `gopher://` and friends are refused.
- Whether private, loopback and link-local ranges are refused after DNS
  resolution, not just by a string check on the hostname.
- Whether redirects are followed. An allow-listed host that answers 302
  to `http://169.254.169.254/` defeats a host check done once up front.

What to cite: the line making the request, quoted whole with file and
line, and, as supporting quotes, the line the untrusted host arrives on
and any validation you did find, so the finding shows what guard is
missing rather than asserting there is none.

Suppress when:

- the base URL is a constant or comes from configuration and only a path
  or query value comes from input
- the value is checked against an allow-list of hosts, or resolved and
  checked against blocked ranges, before the request
- the request goes through a proxy or fetch helper in the repository
  that does those checks (find it and read it before deciding)

A request with a trusted host and no timeout is a different problem:
that is the `fetch-without-timeout` lens, not this one.
