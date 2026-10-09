from django.conf import settings
from django.urls import include, path

from mysite import views

urlpatterns = [
    path("old/", views.old, name="old"),
]

urlpatterns = [
    path("new/", views.new, name="new"),
    path("branchy/", include("mysite.branchy")),
]

if settings.DEBUG:
    urlpatterns += [path("debug/", views.debug, name="debug")]
