from django.dispatch import Signal as DjangoSignal, receiver

from mysite.events import Signal

fake = Signal()
real = DjangoSignal()


@receiver(fake)
def on_fake(sender, **kwargs):
    return None


@receiver(real)
def on_real(sender, **kwargs):
    return None
