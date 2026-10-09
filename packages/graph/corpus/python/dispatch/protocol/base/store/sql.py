from .repo import Repo


class SqlRepo(Repo):
    def find(self, key: str) -> str:
        return "sql " + key
