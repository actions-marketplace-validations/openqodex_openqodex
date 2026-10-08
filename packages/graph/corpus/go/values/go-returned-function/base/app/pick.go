package app

func onA() string {
	return "a"
}

func onB() string {
	return "b"
}

func pick(k bool) func() string {
	if k {
		return onA
	}
	return onB
}
