from django.urls import path

from . import views

app_name = "blog"
urlpatterns = [
    path("", views.post_list, name="post-list"),
    path("<int:pk>/", views.post_detail, name="post-detail"),
    path("about/", views.About.as_view(), name="about"),
]
