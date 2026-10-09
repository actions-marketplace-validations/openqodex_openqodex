from abc import ABC, abstractmethod


class Repo(ABC):
    @abstractmethod
    def find(self, key):
        """Return the row stored under key."""

    def save(self, key):
        raise NotImplementedError
