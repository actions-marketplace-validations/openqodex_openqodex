# Django REST framework: router options and the actions a viewset has

Guards against invented API routes: a `SimpleRouter(trailing_slash=False)` makes paths without a trailing slash; a viewset that defines only `list` has a list route answering GET and no detail route; `ModelViewSet` has every action and `ReadOnlyModelViewSet` only list and retrieve, by the framework's own classes; a viewset whose base comes from elsewhere has routes whose methods are not known, with a gap. A `router.urls` reached through an imported module is followed.
