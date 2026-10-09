from django.urls import path

from alpha import views

urlpatterns = [
    path("health/", views.health, name="health"),
]
