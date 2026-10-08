# Django: shapes read on a real application

Guards against three misses found by running the plugin on djangoproject.com: a view that is an instance of a class (a feed), which must bind to the class and its `__call__`; a foreign key that names by string a model defined later in the same file; and a foreign key to `auth.User`, a model of an installed Django app outside the repository, which is not a gap.
