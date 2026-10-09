from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [
        migrations.CreateModel(name="Book", fields=[("id", models.AutoField(primary_key=True))]),
        migrations.CreateModel(name="Shelf", fields=[("id", models.AutoField(primary_key=True))]),
    ]
