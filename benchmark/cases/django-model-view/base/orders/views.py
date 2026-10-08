from django.contrib.auth.decorators import login_required
from django.http import JsonResponse

from .models import Order


@login_required
def order_list(request):
    orders = Order.objects.filter(owner=request.user).order_by("-created_at")
    return JsonResponse({"orders": [{"id": o.pk, "total": str(o.total)} for o in orders]})
