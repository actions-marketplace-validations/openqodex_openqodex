from django.db import migrations, models


def fill_titles(apps, schema_editor):
    pass


NAME = "isbn"


class Migration(migrations.Migration):
    dependencies = [("library", "0001_initial")]
    operations = [
        migrations.AddField(model_name="book", name="title", field=models.CharField(max_length=200)),
        migrations.RenameField("book", "subtitle", "tagline"),
        migrations.AddField(model_name="book", name=NAME, field=models.CharField(max_length=13)),
        migrations.RunPython(fill_titles),
    ]
