from .pick import pick


def run(k):
    return pick(k)()


def later(k):
    h = pick(k)
    return h()
