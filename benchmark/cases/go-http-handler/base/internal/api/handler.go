package api

import (
	"database/sql"
	"net/http"
)

// Handler serves the directory API.
type Handler struct {
	DB          *sql.DB
	UpstreamURL string
}

func NewHandler(db *sql.DB, upstream string) *Handler {
	return &Handler{DB: db, UpstreamURL: upstream}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	if err := h.DB.PingContext(r.Context()); err != nil {
		http.Error(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
