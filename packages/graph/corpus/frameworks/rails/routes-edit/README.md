# Rails: a change to the routes file alone

Guards against a graph that keeps the old routes when only config/routes.rb changes. The change adds `:show` to `only:`; no controller changes. The new `GET /posts/:id` registration must appear, bound to the existing `PostsController#show`, and the brief must list it as declared by this change.
