package pkg

type Outer struct {
	Inner
}

func (o *Outer) M() string {
	return "outer2"
}
