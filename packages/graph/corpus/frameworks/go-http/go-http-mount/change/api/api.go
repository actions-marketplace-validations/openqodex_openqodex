package api

import "net/http"

// Mux is the API's own mux; main mounts it under /api with the prefix stripped.
var Mux = http.NewServeMux()

func init() {
	Mux.HandleFunc("GET /users/{id}", GetUser)
}

func GetUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	w.Write([]byte(id))
}
