from django.conf.urls import url
from django.urls import path, re_path

from mysite import views

path, other = views.fake, None
for re_path in [views.fake]:
    pass
with views.opened() as url:
    pass

urlpatterns = [
    path("gone/", views.page),
    re_path(r"^gone2/$", views.page),
    url(r"^gone3/$", views.page),
]
