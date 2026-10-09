# A registry with a get decorator, unrelated to FastAPI: its uses are no routes.
class Registry:
    def get(self, path):
        def wrap(fn):
            return fn

        return wrap


app = Registry()


@app.get("/cached")
def cached():
    return 1
