package app

import "example.com/shop/store"

func Run(r store.Repo) string {
	return r.Find("1")
}
