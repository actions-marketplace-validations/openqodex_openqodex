package main

import (
	"example.com/fakehttp/http"
)

func home() { println("home") }

func logging(next http.Handler) http.Handler { return next }

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /home", home)
	mux.Handle("/wrapped/", logging(home))
	http.HandleFunc("/top", home)
	http.ListenAndServe(":8080", mux)
}
