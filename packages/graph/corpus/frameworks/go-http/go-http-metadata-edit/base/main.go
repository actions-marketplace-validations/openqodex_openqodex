package main

import (
	"net/http"

	"example.com/shop/handlers"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ping", handlers.Ping)
	mux.Handle("/api/", http.StripPrefix("/api", handlers.API))
	http.ListenAndServe(":8080", mux)
}
