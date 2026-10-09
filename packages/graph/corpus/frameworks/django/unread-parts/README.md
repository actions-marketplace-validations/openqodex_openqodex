# Django: what the facts cannot read is said, never dropped

Guards against routes lost without a word: a URL list joined in from the same module (`base + [...]`) is walked as part of urlpatterns; a part built by a call (`static(...)`), an item that is not a call (`*extra`) and an `append` of a value each become a gap; a URL list nested deeper than the facts read is a gap of its module; and a migration whose operations are built by code is a gap.
