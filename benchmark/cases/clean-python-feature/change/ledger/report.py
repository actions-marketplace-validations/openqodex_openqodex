from ledger.money import to_cents, to_display


def balance(entries: list[str]) -> int:
    """The sum of the entries, in cents."""
    return sum(to_cents(entry) for entry in entries)


def balance_line(entries: list[str]) -> str:
    """The balance as one line for the monthly statement."""
    return f"Balance: {to_display(balance(entries))}"
