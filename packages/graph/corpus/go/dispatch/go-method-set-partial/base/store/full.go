package store

type Full struct{}

func (f *Full) Get(key string) string {
	return "full " + key
}

func (f *Full) Put(key string, value string) {}
