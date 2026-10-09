class Session:
    def __init__(self):
        self.open = True

    def close(self):
        self.open = False
