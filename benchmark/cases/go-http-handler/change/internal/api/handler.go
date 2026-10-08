package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

// Handler serves the directory API.
type Handler struct {
	DB          *sql.DB
	UpstreamURL string
	mu          sync.Mutex
	hits        map[string]int
}

func NewHandler(db *sql.DB, upstream string) *Handler {
	return &Handler{DB: db, UpstreamURL: upstream, hits: map[string]int{}}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	if err := h.DB.PingContext(r.Context()); err != nil {
		http.Error(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Search lists the users with the given name.
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	query := fmt.Sprintf("SELECT id, name FROM users WHERE name = '%s'", name)
	rows, err := h.DB.QueryContext(r.Context(), query)
	if err != nil {
		http.Error(w, "search failed", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	type user struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	users := []user{}
	for rows.Next() {
		var u user
		if err := rows.Scan(&u.ID, &u.Name); err != nil {
			http.Error(w, "search failed", http.StatusInternalServerError)
			return
		}
		users = append(users, u)
	}
	_ = json.NewEncoder(w).Encode(users)
}

// Count counts the requests for one key and answers with the count so far.
func (h *Handler) Count(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	h.mu.Lock()
	if key == "" {
		http.Error(w, "missing key", http.StatusBadRequest)
		return
	}
	h.hits[key]++
	n := h.hits[key]
	h.mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]int{"count": n})
}

// Upstream reports the status code of the upstream service.
func (h *Handler) Upstream(w http.ResponseWriter, r *http.Request) {
	code, err := fetchStatus(h.UpstreamURL)
	if err != nil {
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]int{"status": code})
}

func fetchStatus(url string) (int, error) {
	resp, err := http.Get(url)
	defer resp.Body.Close()
	if err != nil {
		return 0, err
	}
	return resp.StatusCode, nil
}
