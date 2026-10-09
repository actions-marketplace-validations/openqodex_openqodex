from django.conf import settings
from django.conf.urls.static import static
from django.urls import path

from mysite import views
from mysite.patterns import make_patterns

base = [path("base/", views.page, name="base")]
extra = make_patterns()
urlpatterns = base + [path("own/", views.page, name="own")]
urlpatterns += static(settings.STATIC_URL)
urlpatterns += [*extra, path("tail/", views.page, name="tail")]
urlpatterns.append(extra)
