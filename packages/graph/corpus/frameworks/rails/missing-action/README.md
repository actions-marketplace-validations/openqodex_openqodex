# Rails: deleting an action keeps its route, with no handler

Guards against a deleted controller action silently deleting its route. `resources :posts, only: [:index, :destroy]` still declares `DELETE /posts/:id` after the change deletes `PostsController#destroy`; Rails would answer that route with an error. The registration must stay, with its handler status "missing", a gap that names `posts#destroy`, and a brief line that says the route has no handler now.
