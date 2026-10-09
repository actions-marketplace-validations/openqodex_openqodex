from django.urls import path as route, re_path as regex

from shop import views as v

urlpatterns = [
    route("items/", v.item_list, name="items"),
    regex(r"^items/(?P<pk>\d+)/$", v.item_detail, name="item"),
]
