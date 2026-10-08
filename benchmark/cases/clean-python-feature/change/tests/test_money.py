import pytest

from ledger.money import to_cents, to_display
from ledger.report import balance_line


def test_to_cents_reads_whole_and_fraction():
    assert to_cents("12.34") == 1234
    assert to_cents("12.3") == 1230
    assert to_cents("12") == 1200
    assert to_cents("-0.05") == -5


def test_to_cents_rejects_what_is_not_an_amount():
    for bad in ["", "1.234", "abc", "1.x"]:
        with pytest.raises(ValueError):
            to_cents(bad)


def test_to_display_formats_dollars_with_separators():
    assert to_display(123456) == "$1,234.56"
    assert to_display(5) == "$0.05"
    assert to_display(0) == "$0.00"
    assert to_display(-5) == "-$0.05"


def test_balance_line_shows_the_sum():
    assert balance_line(["12.34", "-0.34"]) == "Balance: $12.00"
