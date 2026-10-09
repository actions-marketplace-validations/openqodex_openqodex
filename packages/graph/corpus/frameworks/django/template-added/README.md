# Django: a template file appears

Guards against a stale template link: in the base, `Landing` names `pages/landing.html` and no such file exists, which is a gap. The change adds the file and edits no Python file; the graph of the change links `Landing` to the new template.
