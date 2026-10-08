# Rails: route-shaped calls outside a draw block are not routes

Guards against reading any `get "/x"` call as a route. lib/client.rb is an HTTP client whose `get "/posts"` and `get "/x", to: "posts#index"` calls, and whose `resources :posts`, are outside any `routes.draw` block; lib/top.rb has a top-level `get` with a `to:`; lib/schema_helper.rb calls `create_table` outside db/migrate. None of them is a registration, a handler link, a schema change or a test request.
