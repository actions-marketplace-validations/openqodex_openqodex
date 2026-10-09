from django.db.models.signals import post_save
from django.dispatch import Signal, receiver as on

from celery_tools import receiver

from news.models import Story

published = Signal()


@on(post_save, sender=Story)
def index_story(sender, instance, **kwargs):
    return None


def notify(sender, **kwargs):
    return None


published.connect(notify)


@receiver("task-done")
def not_a_django_receiver(**kwargs):
    return None
