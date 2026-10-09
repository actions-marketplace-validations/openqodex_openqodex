package handlers

import "net/http"

type AdminHandler struct{}

func (AdminHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("admin"))
}
