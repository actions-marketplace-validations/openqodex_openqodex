package api

import (
	ht "net/http/httptest"
	tst "testing"
)

func TestGetUser(t *tst.T) {
	req := ht.NewRequest("GET", "/api/users/7", nil)
	rec := ht.NewRecorder()
	GetUser(rec, req)
}

func TestComputedPath(t *tst.T) {
	id := "7"
	ht.NewRequest("GET", "/api/users/"+id, nil)
}
