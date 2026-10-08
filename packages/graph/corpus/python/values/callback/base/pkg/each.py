def each(items, cb):
    for item in items:
        cb(item)


def each_with(items, *, on_item):
    for item in items:
        on_item(item)
