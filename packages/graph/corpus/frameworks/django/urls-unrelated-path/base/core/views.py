from core.helpers import render


def home(request):
    return render(request, "core/home.html")


def legacy(request):
    return None
