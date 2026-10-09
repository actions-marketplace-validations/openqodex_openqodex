from app.db import Session


def get_db():
    session = Session()
    try:
        yield session
    finally:
        session.close()


def require_user(token: str = ""):
    if not token:
        raise PermissionError("no token")
    return token
