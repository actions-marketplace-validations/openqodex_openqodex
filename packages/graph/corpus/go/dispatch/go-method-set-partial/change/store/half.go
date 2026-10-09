package store

type Half struct{}

func (h *Half) Get(key string) string {
	return "half:" + key
}
