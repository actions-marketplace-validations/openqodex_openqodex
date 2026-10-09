from django.urls import include, path
from wagtail.admin import urls as wagtailadmin_urls

from site_app import extra_urls
from site_app.api import api_router

urlpatterns = [
    path("admin/", include(wagtailadmin_urls)),
    path("extra/", include(extra_urls)),
    path("api/v2/", api_router.urls),
]
