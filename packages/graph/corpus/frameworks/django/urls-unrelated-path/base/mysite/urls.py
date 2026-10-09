from django.urls import path

from core import views
from core.compat import path as compat_path

urlpatterns = [
    path("home/", views.home, name="home"),
    compat_path("legacy/", views.legacy),
]
