package store

type Repo interface {
	Find(id string) string
}
