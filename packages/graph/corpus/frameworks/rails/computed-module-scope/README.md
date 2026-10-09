# Rails: a scope whose module is computed

Guards against binding a guessed controller: `scope module: selected_module` makes the controller of every route inside depend on a value the graph cannot read, so `posts#index` there is not `PostsController#index` at the root; the handler is computed, with a gap. The same route outside the scope binds.
