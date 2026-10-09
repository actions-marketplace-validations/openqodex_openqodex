from django.conf import settings
from django.urls import path

from mysite import views

if settings.DEBUG:
    urlpatterns = [path("a/", views.new, name="branch-a")]
else:
    urlpatterns = [path("b/", views.old, name="branch-b")]
