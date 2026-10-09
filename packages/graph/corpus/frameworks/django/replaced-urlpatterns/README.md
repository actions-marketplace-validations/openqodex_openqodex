# Django: a URL list replaced, extended and assigned in branches

Guards against registering routes Django never serves: a `urlpatterns` list replaced by a later assignment is gone, so its entries are no registrations. A later `+=` under `if settings.DEBUG:` extends the list Django serves and stays registered. A list assigned in both branches of an `if` keeps the entries of both branches, with a gap that says only one branch is served.
