from django.urls import include, path

from mysite import views

path = lambda *args, **kwargs: None

urlpatterns = [
    path("gone/", views.page),
    include("mysite.more"),
]
