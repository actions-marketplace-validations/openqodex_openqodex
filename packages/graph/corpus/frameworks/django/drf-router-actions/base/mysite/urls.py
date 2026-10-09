from django.urls import include, path

from mysite import api

urlpatterns = [
    path("api/", include(api.router.urls)),
]
