from django.db.models import signals
from django.dispatch import receiver


@receiver(getattr(signals, "post_save"))
def on_saved(sender, **kwargs):
    return None
