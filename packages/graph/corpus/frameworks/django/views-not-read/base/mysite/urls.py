from django.urls import path

from mysite import views

urlpatterns = [
    path("page/", views.page, name="page"),
]
