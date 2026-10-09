# Django: models, fields, relations and migrations

Guards against losing a model's migrations and relations: a model through an abstract in-repo base, fields imported by name, a foreign key by class and by "app.Model" string, a declared table name and a default one, and migrations whose operations name the model. A class whose `Model` comes from another ORM is not a model, and a computed field name in a migration is a gap. A change to the model lists its migrations.
