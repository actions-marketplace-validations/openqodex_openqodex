package impl

type Sql struct{}

func (s *Sql) Find(id string) string {
	return "sql:" + id
}
