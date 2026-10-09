from fastapi import Depends

from app.web import APIRouter, FastAPI


def get_settings():
    return {"debug": False}


app = FastAPI(title="local")
router = APIRouter(prefix="/r")


@router.get("/inner")
def inner(settings=Depends(get_settings)):
    return settings


@app.get("/")
def home():
    return "home"


app.include_router(router, prefix="/nested")
