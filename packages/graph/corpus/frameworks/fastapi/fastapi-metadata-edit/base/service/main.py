from fastapi import FastAPI

from service.ping import ping_status

app = FastAPI()


@app.get("/ping")
def ping():
    return ping_status()
