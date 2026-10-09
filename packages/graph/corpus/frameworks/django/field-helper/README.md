# Django: a helper named like a field

Guards against a field proved by its name: `CharField` imported from the project's own helpers returns a string, so `label` is no model field; `models.CharField` is.
