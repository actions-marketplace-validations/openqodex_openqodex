import fastapi

admin = fastapi.FastAPI()


@admin.get("/health")
def admin_health():
    return {"admin": True}


PROBE_VERSION = 2


@admin.get("/v" + str(PROBE_VERSION) + "/probe")
def admin_probe():
    return {"probe": True}
