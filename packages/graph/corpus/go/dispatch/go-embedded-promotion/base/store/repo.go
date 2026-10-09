package store

type Repo interface {
	Find(id string) string
	Save(id string)
}

func Load(r Repo) string {
	return r.Find("1")
}
