package store

type Base struct{}

func (b *Base) Find(id string) string {
	return "base:" + id
}
