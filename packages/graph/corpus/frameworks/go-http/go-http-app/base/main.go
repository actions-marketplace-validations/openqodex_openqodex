package main

import (
	"log"
	"net/http"
	"os"

	"example.com/shop/handlers"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items/{id}", handlers.GetItem)
	mux.HandleFunc("POST /items", handlers.CreateItem)
	mux.Handle("/admin/", logging(handlers.AdminHandler{}))
	mux.Handle("/static/", http.HandlerFunc(serveStatic))

	version := os.Getenv("API_VERSION")
	mux.HandleFunc("/v"+version+"/status", healthz)

	http.HandleFunc("/healthz", healthz)

	go func() {
		log.Fatal(http.ListenAndServe(":9090", nil))
	}()
	log.Fatal(http.ListenAndServe(":8080", mux))
}

func healthz(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func serveStatic(w http.ResponseWriter, r *http.Request) {
	http.NotFound(w, r)
}
