from fastapi import FastAPI

from app.routers import items, users

app = FastAPI(title="inventory")

app.include_router(items.router, prefix="/items")
app.include_router(users.api)


@app.get("/health")
def health():
    return {"ok": True}
