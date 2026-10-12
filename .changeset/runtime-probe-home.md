---
"openqodex": patch
---

- The checks that look for Go, Rust and Ruby no longer write into your home folder. They run in a folder of their own, `~/.openqodex/cache/runtime-probe` (under `$OPENQODEX_HOME` when you set it), so Go's telemetry files and rustup's settings land there. They still find a Rust or Go you keep in your home folder. A library host's server review runs them inside its own work folder.
