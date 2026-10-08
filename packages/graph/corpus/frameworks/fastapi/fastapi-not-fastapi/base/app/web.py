# A tiny web layer of the repository's own, with the names FastAPI uses.


class FastAPI:
    def __init__(self, title=""):
        self.title = title
        self.routes = {}

    def get(self, path):
        def wrap(fn):
            self.routes[path] = fn
            return fn

        return wrap

    def include_router(self, router, prefix=""):
        for path, fn in router.routes.items():
            self.routes[prefix + path] = fn


class APIRouter(FastAPI):
    def __init__(self, prefix=""):
        super().__init__()
        self.prefix = prefix
