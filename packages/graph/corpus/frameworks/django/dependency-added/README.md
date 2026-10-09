# Django: the dependency is added after the code

Guards against stale framework output: the base declares no Django dependency, so its files make no application and no route. The change adds Django to requirements.txt and edits no Python file; the graph of the change must hold the application and its routes, read again from the unchanged files.
