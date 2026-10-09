package pkg

type Both struct {
	Left
	Right
}

func Use() string {
	b := Both{}
	return b.M()
}
