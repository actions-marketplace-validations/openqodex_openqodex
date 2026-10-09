# Rails: a controller over the size the graph reads

Guards against calling an action missing when its controller was never read: `app/controllers/posts_controller.rb` is over the build's size cap, so the route's handler is unresolved, with a gap of cause `file-not-parsed`, and never `missing`.
