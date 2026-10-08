def to_cents(amount: str) -> int:
    """Parses an amount such as "12.34" or "-0.05" into whole cents."""
    sign = -1 if amount.startswith("-") else 1
    whole, _, frac = amount.lstrip("+-").partition(".")
    if not whole.isdigit() or (frac and (not frac.isdigit() or len(frac) > 2)):
        raise ValueError(f"not an amount: {amount!r}")
    return sign * (int(whole) * 100 + int(frac.ljust(2, "0") or "0"))
