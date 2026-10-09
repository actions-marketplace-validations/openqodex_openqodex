from django.db import models

from mysite.helpers import CharField


class Note(models.Model):
    title = models.CharField(max_length=10)
    label = CharField(max_length=10)
