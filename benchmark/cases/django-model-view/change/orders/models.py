from decimal import Decimal

from django.conf import settings
from django.db import models


class Order(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="orders")
    total = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0.00"))
    created_at = models.DateTimeField(auto_now_add=True)
    discount_code = models.CharField(max_length=32, blank=True, default="")

    def __str__(self) -> str:
        return f"Order {self.pk} for {self.owner_id}"

    def apply_discount(self, code: str) -> None:
        """Takes 10 percent off for the welcome code, once per order."""
        if self.discount_code or code != "WELCOME10":
            return
        self.total = self.total * 0.9
        self.discount_code = code
        self.save(update_fields=["total", "discount_code"])
