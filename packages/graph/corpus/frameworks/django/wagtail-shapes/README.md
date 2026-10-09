# Django: shapes read on a Wagtail site

Guards against three errors found by running the plugin on Wagtail's bakery demo: `include()` of an imported URL module (in the repository, or a dependency's) was reported as an unsupported rule; a router value used as a view (`api_router.urls`) was reported as a missing view, although it is a module-level value the graph does not follow; and a foreign key naming a class whose model base comes from a dependency was reported as a missing model.
