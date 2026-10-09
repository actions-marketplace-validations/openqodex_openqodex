from .each import each, each_with
from .log import note, show
from .runner import Runner


def main(xs):
    each(xs, show)
    each_with(xs, on_item=note)
    Runner().apply(xs, show)
