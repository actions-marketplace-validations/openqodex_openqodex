from django.urls import include, path

from api import views

VERSION = "v1"
APP = "api"

urlpatterns = [
    path(f"{VERSION}/status/", views.status, name="status"),
    path("mod/", include(f"{APP}.urls")),
    path("fixed/", views.make_view("x"), name="made"),
    path("ok/", views.ok, name="ok"),
]
