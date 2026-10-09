from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_db, require_user
from app.models import Item, ItemIn

router = APIRouter(prefix="/v1")

ITEMS = {1: Item(id=1, title="Lamp")}


@router.get("/{item_id}")
def read_item(item_id: int, db=Depends(get_db)) -> Item:
    if item_id not in ITEMS:
        raise HTTPException(status_code=404)
    return ITEMS[item_id]


@router.post("/", dependencies=[Depends(require_user)])
async def create_item(item: ItemIn, db=Depends(get_db)) -> Item:
    new = Item(id=len(ITEMS) + 1, title=item.title)
    ITEMS[new.id] = new
    return new


LEGACY = "/legacy"


@router.get(LEGACY + "/{item_id}")
def legacy_item(item_id: int) -> Item:
    return ITEMS[item_id]
