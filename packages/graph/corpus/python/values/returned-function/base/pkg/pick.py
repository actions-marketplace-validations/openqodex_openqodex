def on_a():
    return "a"


def on_b():
    return "b"


def pick(k):
    if k:
        return on_a
    return on_b
