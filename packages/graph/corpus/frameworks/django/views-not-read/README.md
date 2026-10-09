# Django: a views module over the size the graph reads

Guards against calling a view missing when its module was never read: `mysite/views.py` is over the build's size cap, so the route's handler is unresolved, with a gap of cause `file-not-parsed`, and never `missing`.
