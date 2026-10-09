class Runner:
    def apply(self, items, cb):
        for item in items:
            cb(item)
