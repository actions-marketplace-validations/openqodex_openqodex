package handlers

import (
	"encoding/json"
	"net/http"
)

type Item struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

var items = map[string]Item{"1": {ID: "1", Title: "Lamp"}}

func GetItem(w http.ResponseWriter, r *http.Request) {
	item, ok := items[r.PathValue("id")]
	if !ok {
		http.Error(w, "no such item", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(item)
}

func CreateItem(w http.ResponseWriter, r *http.Request) {
	var item Item
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	items[item.ID] = item
	w.WriteHeader(http.StatusCreated)
}
