package main

import (
	"testing"

	httptest "example.com/fakehttp/http"
)

func TestHome(t *testing.T) {
	httptest.NewRequest("GET", "/home")
	home()
}
