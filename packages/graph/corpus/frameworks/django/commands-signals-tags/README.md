# Django: management commands, signals and template tags

Guards against missing Django entry points that are not routes: a management command run by its `handle`, a `post_save` receiver connected through an aliased `receiver`, a project signal connected with `connect`, and template tags registered on a `template.Library()`. A `receiver` from another library and a `Library()` from another package make nothing.
