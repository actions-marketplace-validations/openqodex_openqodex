# Repository conventions

## Verb-noun

New route handlers in app/ use verb_noun names, with the HTTP method first. A GET /health handler is named get_health, not health_check.

Exception: the GET /health handler in app/server.py may be named health_check. The verb_noun rule does not apply to this health endpoint.
