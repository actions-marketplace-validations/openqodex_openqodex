---
"openqodex": minor
---

The review brief now lists the Django and Rails routes that reach the changed code, with their full paths and names, routes left without a handler, the templates and views it renders, a changed model's migrations, and the tests that call it, request its route or name it.
A route stays listed when its view or action is deleted, and the brief says it has no handler now.
Django and Rails are read only when a manifest declares them and the project has the framework's own settings or routes file; nothing from the repository is imported or run, and no regular expression from it is built.
Every route path, route name and template name quoted in the brief is on one line, cut to 120 characters and set inside a table cell.
Python dependencies declared in files that a requirements file includes with `-r` or `-c`, in a `requirements/` folder or in pip-tools `.in` files are now read, so Django is found in those layouts.
The Django and Rails facts cached under `.openqodex/graph/` keep a string from your code only where the plugin reads its value (a route path, a route name, a template, a model, table or field name), with key-shaped tokens redacted and nothing over 512 characters kept, so a key in a setting, a route option, a route path or a test request is not copied there.
