from django.conf import settings
from rest_framework import viewsets

more = []


def page(request):
    return getattr(settings, "FEATURE_" + request.GET["x"])


class ItemViewSet(viewsets.ReadOnlyModelViewSet):
    pass
