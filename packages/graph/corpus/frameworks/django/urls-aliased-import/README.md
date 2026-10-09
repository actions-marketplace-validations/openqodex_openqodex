# Django: aliased imports of the URL and render functions

Guards against a registration rule that matches only the literal names `path` and `include`: here `path`, `re_path`, `include`, `render` and the views module are imported under other names, and every registration, mount, render and test request must still be found through the imports.
