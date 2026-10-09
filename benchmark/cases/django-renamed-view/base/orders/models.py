from django.db import models


class Order(models.Model):
    number = models.CharField(max_length=20, unique=True)
    total_cents = models.IntegerField(default=0)
    created = models.DateTimeField(auto_now_add=True)
