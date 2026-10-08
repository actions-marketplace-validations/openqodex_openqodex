from django.urls import path

from tracker.feeds import LatestIssues

urlpatterns = [
    path("rss/issues/", LatestIssues(), name="issues-feed"),
]
