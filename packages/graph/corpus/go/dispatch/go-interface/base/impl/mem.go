package impl

type Mem struct{}

func (m Mem) Find(id string) string {
	return "mem " + id
}
