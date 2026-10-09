from django.test import TestCase
from django.urls import reverse

from .views import helper


class PostTests(TestCase):
    def test_detail(self):
        self.client.get("/blog/1/")

    def test_list(self):
        self.client.get(reverse("blog:post-list"))

    def test_helper(self):
        helper(1)
