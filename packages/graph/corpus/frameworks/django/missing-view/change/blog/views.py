from django.conf import settings
from django.shortcuts import render
from django.views import View

from .models import Post


def helper(pk):
    return Post.objects.get(pk=pk)


def post_list(request):
    return render(request, "blog/post_list.html", {})


class About(View):
    template_name = "blog/about.html"

    def get(self, request):
        return None
