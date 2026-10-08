RATES = {"us-ca": 0.0725, "us-ny": 0.04, "de": 0.19}


def tax_for(amount_cents: int, region: str) -> int | None:
    """Tax in cents for an amount in a region, or None when the region is unknown."""
    rate = RATES.get(region)
    if rate is None:
        return None
    return round(amount_cents * rate)
