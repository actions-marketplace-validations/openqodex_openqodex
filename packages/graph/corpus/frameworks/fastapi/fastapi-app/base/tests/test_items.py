from fastapi.testclient import TestClient

from app.main import app
from app.routers.items import read_item

client = TestClient(app)


def test_read_item():
    response = client.get("/items/v1/1")
    assert response.status_code == 200


def test_read_item_direct():
    assert read_item(1).title == "Lamp"
