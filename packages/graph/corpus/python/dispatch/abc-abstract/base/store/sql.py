from .repo import Repo


class SqlRepo(Repo):
    def find(self, key):
        return "sql " + key

    def save(self, key):
        return "saved " + key
