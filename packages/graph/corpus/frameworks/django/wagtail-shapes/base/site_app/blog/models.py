from django.db import models


class Post(models.Model):
    author = models.ForeignKey("people.Person", on_delete=models.CASCADE)
