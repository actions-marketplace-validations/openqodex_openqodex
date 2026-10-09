from django.urls import re_path

from mysite import views

urlpatterns = [
    re_path(r"^year/(?P<year>\d{4})/$", views.year, name="year"),
]
