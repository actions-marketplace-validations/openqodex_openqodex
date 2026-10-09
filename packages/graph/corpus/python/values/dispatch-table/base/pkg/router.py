from .handlers import on_remove, on_save

HANDLERS = {"save": on_save, "remove": on_remove}


def handle(k, x):
    return HANDLERS[k](x)
