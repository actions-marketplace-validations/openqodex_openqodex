from rest_framework import routers, viewsets

from somewhere import CustomBase


class ListOnly(viewsets.ViewSet):
    def list(self, request):
        return None


class Everything(viewsets.ModelViewSet):
    pass


class ReadOnly(viewsets.ReadOnlyModelViewSet):
    pass


class Unknown(CustomBase):
    pass


router = routers.SimpleRouter(trailing_slash=False)
router.register("lists", ListOnly, basename="lists")
router.register("all", Everything, basename="all")
router.register("ro", ReadOnly, basename="ro")
router.register("unknown", Unknown, basename="unknown")
