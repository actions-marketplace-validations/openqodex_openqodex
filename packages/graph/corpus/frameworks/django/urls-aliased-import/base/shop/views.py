from django.shortcuts import render as show


def item_list(request):
    return show(request, "shop/items.html")


def item_detail(request, pk):
    return None
