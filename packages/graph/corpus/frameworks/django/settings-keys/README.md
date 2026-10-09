# Django: settings keys read in code

Guards against config links by name: `settings.X` read through `django.conf` (directly or through the module path) links the reading function to the key the settings module assigns, a `getattr` with a literal key links to a key the settings module does not assign, and a project module named like settings links nothing. Values are never recorded.
