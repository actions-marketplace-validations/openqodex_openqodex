from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Publish stories"

    def handle(self, *args, **options):
        return None
