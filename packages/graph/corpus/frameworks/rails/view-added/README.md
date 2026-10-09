# Rails: a view file added with no source change

Guards against a graph that keeps its old view links when only a view file changes. The change adds `app/views/pages/about.html.erb` and touches no Ruby file; `PagesController#about` renders no template by name, so Rails renders the new file by the implicit view rule. The link must appear, and the brief must list the new view with the action that renders it.
