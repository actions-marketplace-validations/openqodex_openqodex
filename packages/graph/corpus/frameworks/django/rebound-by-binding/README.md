# Django: an imported name rebound by unpacking, a loop or a with

Guards against taking a name as proof of Django's API when a module-level statement other than a plain assignment rebinds it: `path` unpacked from a tuple, `re_path` the target of a loop, and `url` the target of a `with`. None of their entries is a route; the plain entry is.
