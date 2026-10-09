# Django: Django code with no Django dependency declared

Guards against a framework detected from imports alone: the files import Django, but no manifest declares it, so the plugin enables no rule and emits no application, registration or role.
