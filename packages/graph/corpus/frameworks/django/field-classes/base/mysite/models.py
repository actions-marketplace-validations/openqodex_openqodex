from django.contrib.contenttypes.fields import GenericRelation
from django.db import models

from mysite.fields import Amount, CentsField, MoneyField
from mysite.managers import Shelf


class Product(models.Model):
    price = MoneyField(max_digits=8, decimal_places=2)
    cents = CentsField(max_digits=8, decimal_places=0)
    amount = Amount()
    notes = GenericRelation("Note")
    objects = models.Manager()
    shelf = Shelf()
