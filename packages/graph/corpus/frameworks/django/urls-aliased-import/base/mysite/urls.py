import django.urls as du
from django.urls import include as mount

urlpatterns = [
    du.path("shop/", mount("shop.urls")),
]
