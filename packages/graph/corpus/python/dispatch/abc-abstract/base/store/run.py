from .repo import Repo


def run(repo: Repo):
    return repo.find("1")


def store(repo: Repo):
    return repo.save("1")
