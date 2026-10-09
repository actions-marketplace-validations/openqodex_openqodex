package fake

// A local value named http: its HandleFunc is not the standard library's.
type server struct{}

func (server) HandleFunc(pattern string, f func()) {}

func Register() {
	http := server{}
	http.HandleFunc("/not-a-route", func() {})
}
