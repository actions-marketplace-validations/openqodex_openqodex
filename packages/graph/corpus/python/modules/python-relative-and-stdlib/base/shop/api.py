import json

from .prices import with_tax


def quote(amount):
    total = with_tax(amount)
    return json.dumps({"total": total})
