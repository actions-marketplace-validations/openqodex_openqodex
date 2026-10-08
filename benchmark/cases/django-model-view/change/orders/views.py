from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .models import Order


@login_required
def order_list(request):
    orders = Order.objects.filter(owner=request.user).order_by("-created_at")
    return JsonResponse({"orders": [{"id": o.pk, "total": str(o.total)} for o in orders]})


@login_required
def order_detail(request, order_id):
    order = get_object_or_404(Order, pk=order_id)
    return JsonResponse({"id": order.pk, "total": str(order.total), "discount": order.discount_code})


@csrf_exempt
@require_POST
@login_required
def redeem(request, order_id):
    order = get_object_or_404(Order, pk=order_id, owner=request.user)
    order.apply_discount(request.POST.get("code", ""))
    return JsonResponse({"total": str(order.total)})
