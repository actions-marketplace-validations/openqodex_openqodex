# Django: an imported name rebound or shadowed at its use

Guards against taking a name as proof of Django's API when the name no longer holds the import where it is used: `path` reassigned at module level before `urlpatterns` is built, a `render` parameter that shadows the import, and a `render` reassigned inside the function. None of them is Django's, so no registration and no render link come from them; the plain `render` call still links.
