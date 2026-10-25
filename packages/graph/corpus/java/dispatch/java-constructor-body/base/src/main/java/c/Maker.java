package c;

public class Maker {
    public Widget make() {
        return new Widget(3); // @NEWW
    }

    public Plain plain() {
        return new Plain(); // @NEWP
    }
}
