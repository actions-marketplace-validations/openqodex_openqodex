from .impl import Impl


class Cached(Impl):
    def find(self, key):
        return "cached " + key
