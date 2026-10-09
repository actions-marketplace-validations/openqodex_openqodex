from .base import Base


class Impl(Base):
    def find(self, key):
        return "impl " + key
