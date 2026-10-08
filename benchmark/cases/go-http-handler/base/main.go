package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"

	"example.com/directory/internal/api"
)

func main() {
	db, err := sql.Open("sqlite3", os.Getenv("DIRECTORY_DB"))
	if err != nil {
		log.Fatal(err)
	}
	h := api.NewHandler(db, os.Getenv("UPSTREAM_URL"))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", h.Health)
	log.Fatal(http.ListenAndServe("127.0.0.1:8080", mux))
}
