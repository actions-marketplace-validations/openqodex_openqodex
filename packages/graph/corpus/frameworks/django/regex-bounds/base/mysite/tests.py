from django.test import TestCase


class YearTests(TestCase):
    def test_short(self):
        self.client.get("/year/7/")

    def test_full(self):
        self.client.get("/year/2024/")
