from django.test import TestCase


class ApiTests(TestCase):
    def test_status(self):
        version = "v1"
        self.client.get(f"/{version}/status/")
