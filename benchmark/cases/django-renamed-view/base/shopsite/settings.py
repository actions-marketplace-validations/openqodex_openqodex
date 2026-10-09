SECRET_KEY = "benchmark-only-not-a-secret"
DEBUG = False
INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.auth", "orders"]
ROOT_URLCONF = "shopsite.urls"
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": "db.sqlite3"}}
TEMPLATES = [{"BACKEND": "django.template.backends.django.DjangoTemplates", "DIRS": [], "APP_DIRS": True}]
