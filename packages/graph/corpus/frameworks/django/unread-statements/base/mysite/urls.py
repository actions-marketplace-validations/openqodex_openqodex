from django.urls import include, path
from rest_framework.routers import DefaultRouter

from mysite import views

router = DefaultRouter()
router.register("items", views.ItemViewSet)

extra = [
    path("extra/", views.page),
] + router.urls
extra.append(path("appended/", views.page))

urlpatterns = [
    path("", include([path("inline/", views.page), *views.more])),
] + extra

for name in ["a", "b"]:
    urlpatterns.append(path(name + "/", views.page))

urlpatterns.insert(0, path("first/", views.page))
urlpatterns.remove(urlpatterns[0])
del urlpatterns[0]
