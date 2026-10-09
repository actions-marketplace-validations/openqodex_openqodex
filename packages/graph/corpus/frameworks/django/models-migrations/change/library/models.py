from django.db.models import CharField, ForeignKey, Model, CASCADE

from library.base import Stamped


class Shelf(Model):
    label = CharField(max_length=20)

    class Meta:
        db_table = "shelves"


class Book(Stamped):
    title = CharField(max_length=250)
    shelf = ForeignKey(Shelf, on_delete=CASCADE)
    editor = ForeignKey("library.Person", on_delete=CASCADE)


class Person(Model):
    name = CharField(max_length=80)
