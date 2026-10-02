---
name: oauth-scope-wider-than-use
description: Connector requests an OAuth scope no code path in it actually uses
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
    - "*.json"
    - "*.yaml"
    - "*.yml"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.mjs"
    - "**/*.py"
    - "**/*.rb"
    - "**/*.go"
    - "**/*.java"
    - "**/*.kt"
    - "**/*.json"
    - "**/*.yaml"
    - "**/*.yml"
  hunk_regex: "scope=|scopes?\\s*[:=]\\s*[\\[\\(\"']|\\.scope\\(|setScope\\(|\"scopes\"\\s*:"
security: true
confidence_floor: 0.75
---

A connector asks the provider for a scope, and nothing in the connector
ever calls an endpoint that needs it. The declaration is usually one
string in an authorize URL, a client constructor, or a manifest, written
once when the integration was built and never narrowed as the feature
shrank. The cost is real: the token the user grants can do more than
the product does, so a leaked token, a compromised server, or a bug in
the connector reaches data and writes the product never intended to
touch. A `full` scope on a connector that only reads one record is the
shape.

How to check, before you flag anything:

- Find the scope declaration. Read the whole line and the call it sits
  in, so you can quote it and say which scopes are requested.
- Enumerate every provider call the connector makes. Search the
  connector's own directory for the provider's base URL, its client
  class, or the SDK method prefix (search for callers of the client,
  then for the base URL) and list the endpoints you found.
- Map each requested scope to the calls that need it, using the
  provider's own scope documentation as the connector states it, not a
  guess about naming.
- Report every scope with no call behind it. One finding per unused
  scope, not one per connector.

What to cite:

- The scope declaration line, with file and line, quoted whole.
- The provider calls you found, each as a supporting quote with its file
  and line. This is what makes the finding checkable: without the list,
  "no call needs this" is an assertion, not evidence.

Suppress when:

- the provider only grants the scope as part of a bundle (some providers
  have no finer grain than `read`), and the connector says so
- the scope is used on a path behind a feature flag or an unreleased
  code path that is still in the tree
- a sibling connector or a shared client in the same repository uses the
  same credential, so the calls live outside this directory; widen the
  search before flagging
- the connector is a thin proxy whose callers make the provider calls

Severity: medium by default. High when the unused scope grants write,
delete, or admin access, since the blast radius of the extra grant is
then the user's data rather than a wider read.
