---
"openqodex": patch
---

- The checks that look for Go and Rust no longer write into your home folder. The Go check runs in a folder of its own, `~/.openqodex/cache/runtime-probe` (under `$OPENQODEX_HOME` when you set it), so Go's telemetry files land there. rustup's settings land there too when you have no `~/.rustup`. A Go, Rust or Ruby you keep in your home folder is still found, including one behind a version manager such as asdf or rbenv. A library host's server review runs these checks inside its own work folder.
