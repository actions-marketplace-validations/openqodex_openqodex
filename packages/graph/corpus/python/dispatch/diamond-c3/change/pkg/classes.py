class A:
    def m(self):
        return "a"


class B(A):
    pass


class C(A):
    def m(self):
        return "c2"


class D(B, C):
    pass
