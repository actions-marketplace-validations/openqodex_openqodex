from django.db import models


class MoneyField(models.DecimalField):
    pass


class CentsField(MoneyField):
    pass


class Amount(models.IntegerField):
    pass
