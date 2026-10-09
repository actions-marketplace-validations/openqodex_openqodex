import fastapi

admin = fastapi.FastAPI()


@admin.get("/health")
def admin_health():
    return {"admin": True}
