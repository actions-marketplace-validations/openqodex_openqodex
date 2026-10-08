from django.urls import path

from beta import views

urlpatterns = [
    path("health/", views.health, name="health"),
]
