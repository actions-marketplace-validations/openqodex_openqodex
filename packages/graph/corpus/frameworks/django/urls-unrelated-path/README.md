# Django: names that look like Django's and are not

Guards against binding by name: a `path` from `os`, a `path` defined in the file itself, a `render` from the project's own helpers and a `Model` from another ORM must produce no registration, no render link and no model, even though the repository is a Django project. An entry in a real URL table whose function is not Django's is reported as a gap, never read as a route.
