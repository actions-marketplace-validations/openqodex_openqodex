from ledger.money import to_cents


def balance(entries: list[str]) -> int:
    """The sum of the entries, in cents."""
    return sum(to_cents(entry) for entry in entries)
