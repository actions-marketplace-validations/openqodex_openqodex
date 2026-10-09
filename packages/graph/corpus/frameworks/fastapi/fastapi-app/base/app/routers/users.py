from fastapi import APIRouter as Router

api = Router(prefix="/users", tags=["users"])


@api.get("/me")
def me():
    return {"name": "ada"}


@api.delete("/{user_id}")
def delete_user(user_id: int):
    return None
