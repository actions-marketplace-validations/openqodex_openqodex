def path(route, view, name=None):
    return route


def ping():
    return "pong"


urlpatterns = [
    path("ping/", ping, name="ping"),
]
