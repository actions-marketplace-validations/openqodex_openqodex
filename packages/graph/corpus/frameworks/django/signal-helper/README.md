# Django: a Signal class that is not Django's

Guards against a signal proved by its constructor's name: `fake` is built by the project's own `Signal` class, whose `connect` does nothing, so `@receiver(fake)` connects nothing the graph can prove; `real` is Django's `Signal` under another name and connects `on_real`.
