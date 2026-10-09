// Package http is the repository's own router, named like the standard library's.
package http

type Handler func()

type Mux struct{ routes map[string]Handler }

func NewServeMux() *Mux { return &Mux{routes: map[string]Handler{}} }

func (m *Mux) HandleFunc(pattern string, h Handler) { m.routes[pattern] = h }

func (m *Mux) Handle(pattern string, h Handler) { m.routes[pattern] = h }

func HandleFunc(pattern string, h Handler) {}

func ListenAndServe(addr string, m *Mux) error { return nil }

func NewRequest(method, target string) {}
