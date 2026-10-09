from django.urls import path

from hc.accounts import views

urlpatterns = [
    path("accounts/login/", views.login, name="hc-login"),
]
