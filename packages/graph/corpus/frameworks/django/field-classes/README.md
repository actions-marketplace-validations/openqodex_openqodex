# Django: field classes by their constructor

Guards against a model field missed because of how its class is named or imported: a field class of the project imported by its module path (`MoneyField`), one two classes away from Django's (`CentsField`), one whose name does not end in Field (`Amount`), and Django's own `GenericRelation` are fields; a manager, Django's or the project's, is not.
