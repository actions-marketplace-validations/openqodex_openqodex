# Rails: a class with a Rails name outside the Rails folders

Guards against binding by name alone. lib/legacy/posts_controller.rb defines another `PostsController`, which no route reaches: the `posts#index` route is handled by app/controllers/posts_controller.rb only, and the legacy class gets no callbacks. lib/legacy/post.rb defines a `Post` based on `ApplicationRecord` outside app/models: it is not a model, and its `has_many` is never linked.
