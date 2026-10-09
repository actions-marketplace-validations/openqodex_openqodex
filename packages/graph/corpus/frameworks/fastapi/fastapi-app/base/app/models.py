from pydantic import BaseModel


class Item(BaseModel):
    id: int
    title: str


class ItemIn(BaseModel):
    title: str
