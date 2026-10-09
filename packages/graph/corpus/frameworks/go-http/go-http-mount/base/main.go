package main

import (
	"log"
	nethttp "net/http"
	"os"

	"example.com/mounts/api"
)

const healthPath = "/healthz"

type server struct{ name string }

func (s *server) health(w nethttp.ResponseWriter, r *nethttp.Request) {
	w.Write([]byte(s.name))
}

func withAudit(next nethttp.Handler) nethttp.Handler {
	return nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		log.Println("audit", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

func main() {
	s := &server{name: "shop"}
	root := nethttp.NewServeMux()
	root.HandleFunc("GET "+healthPath, s.health)
	root.Handle("/api/", nethttp.StripPrefix("/api", api.Mux))
	old := nethttp.NewServeMux()
	old.HandleFunc("/legacy/report", s.health)
	old.HandleFunc("/elsewhere", s.health)
	root.Handle("/legacy/", old)
	root.Handle("/tenant/", nethttp.StripPrefix(os.Getenv("TENANT_PREFIX"), api.Mux))
	root.Handle("/audit/", withAudit(nethttp.HandlerFunc(s.health)))
	srv := &nethttp.Server{Addr: ":8080", Handler: root}
	log.Fatal(srv.ListenAndServe())
}
