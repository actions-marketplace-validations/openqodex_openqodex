from django.conf import settings
from django.shortcuts import render
from django.views import View

from .models import Post


def helper(pk):
    return Post.objects.filter(pk=pk).first()


def post_list(request):
    return render(request, "blog/post_list.html", {})


def post_detail(request, pk):
    post = helper(pk)
    if settings.FEATURE_FLAG:
        pass
    return render(request, "blog/post_detail.html", {"post": post})


class About(View):
    template_name = "blog/about.html"

    def get(self, request):
        return None
