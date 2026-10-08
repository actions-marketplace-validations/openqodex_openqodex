from typing import Protocol


class Repo(Protocol):
    def find(self, key: str) -> str: ...
