from django.urls import path

from site_app import views

urlpatterns = [
    path("ping/", views.ping, name="ping"),
]
