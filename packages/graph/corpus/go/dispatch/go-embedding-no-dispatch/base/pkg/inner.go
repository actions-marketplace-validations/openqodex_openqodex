package pkg

type Inner struct{}

func (i *Inner) M() string {
	return "inner"
}

func (i *Inner) Run() string {
	return i.M()
}
