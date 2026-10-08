from .repo import Repo


def run(repo: Repo) -> str:
    return repo.find("1")
