from django.test import TestCase as Base


class ItemTests(Base):
    def test_item(self):
        self.client.get("/shop/items/7/")
