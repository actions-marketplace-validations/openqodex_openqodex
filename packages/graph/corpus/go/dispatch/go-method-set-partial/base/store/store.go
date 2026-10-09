package store

type Store interface {
	Get(key string) string
	Put(key string, value string)
}

func Read(s Store) string {
	return s.Get("k")
}
