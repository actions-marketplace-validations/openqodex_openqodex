package util

func Each(xs []string, cb func(string)) {
	for _, x := range xs {
		cb(x)
	}
}
