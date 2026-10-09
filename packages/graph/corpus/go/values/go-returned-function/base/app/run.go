package app

func Run(k bool) string {
	return pick(k)()
}

func Later(k bool) string {
	h := pick(k)
	return h()
}
