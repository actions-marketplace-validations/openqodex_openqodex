import pytest

from ledger.money import to_cents


def test_to_cents_reads_whole_and_fraction():
    assert to_cents("12.34") == 1234
    assert to_cents("12.3") == 1230
    assert to_cents("12") == 1200
    assert to_cents("-0.05") == -5


def test_to_cents_rejects_what_is_not_an_amount():
    for bad in ["", "1.234", "abc", "1.x"]:
        with pytest.raises(ValueError):
            to_cents(bad)
