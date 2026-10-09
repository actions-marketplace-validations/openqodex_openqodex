from django.shortcuts import render


def page(request):
    return None


def shadowed(request, render):
    return render(request, "mysite/page.html")


def rebound(request):
    render = make_renderer()
    return render(request, "mysite/page.html")


def real(request):
    return render(request, "mysite/page.html")


def make_renderer():
    return None
