from django.test import TestCase


class LoginTests(TestCase):
    def test_login(self):
        self.client.get("/accounts/login/")

    def test_again(self):
        self.client.post("/accounts/login/")
