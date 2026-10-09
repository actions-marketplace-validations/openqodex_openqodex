from .repo import Repo


class MemRepo(Repo):
    def find(self, key):
        return "mem " + key
