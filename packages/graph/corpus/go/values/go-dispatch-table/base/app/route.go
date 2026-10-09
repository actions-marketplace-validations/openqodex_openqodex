package app

var handlers = map[string]func(string) string{"a": handleA, "b": handleB}

func Route(k string, x string) string {
	return handlers[k](x)
}
