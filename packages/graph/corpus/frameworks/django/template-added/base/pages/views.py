from django.shortcuts import render
from django.template.loader import render_to_string
from django.views.generic import TemplateView
from jinja2 import Template


def page(request):
    return render(request, "pages/page.html")


def shared(request):
    return render(request, "shared.html")


def gone(request):
    return render(request, "pages/gone.html")


def computed(request, name):
    return render(request, "pages/" + name)


def text():
    return render_to_string("pages/page.html")


def not_django():
    return Template("pages/page.html").render()


class Landing(TemplateView):
    template_name = "pages/landing.html"
