from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, render

from orders.models import Order


@login_required
def order_list(request):
    orders = Order.objects.order_by("-created")[:50]
    return render(request, "orders/list.html", {"orders": orders})


@login_required
def order_detail(request, pk):
    order = get_object_or_404(Order, pk=pk)
    return render(request, "orders/detail.html", {"order": order})
