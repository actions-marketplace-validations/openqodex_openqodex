from django.test import TestCase
from django.urls import reverse


class PageTests(TestCase):
    def test_variable(self):
        url = "/inline/"
        self.client.get(url)

    def test_reverse(self):
        self.client.get(reverse("extra"))
