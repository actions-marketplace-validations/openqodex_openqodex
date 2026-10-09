import django.conf
from django.conf import settings

from billing import local_settings


def timeout():
    return settings.PAYMENT_TIMEOUT


def currency():
    return django.conf.settings.CURRENCY


def fee():
    return local_settings.FEE


def retries():
    return getattr(settings, "RETRIES", 3)
