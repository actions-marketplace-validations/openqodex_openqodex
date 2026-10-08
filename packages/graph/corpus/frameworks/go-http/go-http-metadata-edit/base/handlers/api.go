package handlers

import "net/http"

// API is a mux of its own; main mounts it under /api with the prefix stripped.
var API = http.NewServeMux()

func init() {
	API.HandleFunc("GET /version", Version)
}

func Version(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("1"))
}
