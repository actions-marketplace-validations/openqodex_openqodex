from urllib.parse import urlparse

from django.conf import settings
from django.urls import include, path

prefix = ""
if _path := urlparse(settings.SITE_ROOT).path.lstrip("/"):
    prefix = f"{_path}/"

urlpatterns = [
    path(prefix, include("hc.accounts.urls")),
]
