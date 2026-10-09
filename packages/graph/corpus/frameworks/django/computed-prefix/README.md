# Django: a route prefix computed at run time

Guards against losing every route of an application whose root URL module builds its prefix from a setting at run time (healthchecks does this with `SITE_ROOT`). The pattern is not known, so it is null and a gap says why, but the known tail of the route (`{computed}accounts/login/`) is kept for the brief, the view is still bound, and the test requests that cannot be matched are explained once per test file, never matched by a guess.
