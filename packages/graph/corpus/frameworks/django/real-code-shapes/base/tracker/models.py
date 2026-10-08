from django.db import models


class IssueRelease(models.Model):
    issue = models.ForeignKey("Issue", on_delete=models.CASCADE)


class Issue(models.Model):
    reporter = models.ForeignKey("auth.User", on_delete=models.CASCADE)
