package handlers

import (
	"net/http/httptest"
	"testing"
)

func TestGetItem(t *testing.T) {
	req := httptest.NewRequest("GET", "/items/1", nil)
	req.SetPathValue("id", "1")
	rec := httptest.NewRecorder()
	GetItem(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
}
