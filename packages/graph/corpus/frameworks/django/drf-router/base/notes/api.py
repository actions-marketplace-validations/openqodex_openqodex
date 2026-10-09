from rest_framework import routers, viewsets

PREFIX = "x"


class NoteViewSet(viewsets.ModelViewSet):
    def list(self, request):
        return None

    def retrieve(self, request, pk=None):
        return None


router = routers.DefaultRouter()
router.register(r"notes", NoteViewSet, basename="note")
router.register(PREFIX, NoteViewSet)

urlpatterns = []
urlpatterns += router.urls
