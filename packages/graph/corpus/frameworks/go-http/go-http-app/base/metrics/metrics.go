package metrics

import "net/http"

// A second mux with the same pattern as the main one: its route is its own.
func NewMux() *http.ServeMux {
	m := http.NewServeMux()
	m.HandleFunc("GET /items/{id}", itemMetrics)
	return m
}

func itemMetrics(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("0"))
}
