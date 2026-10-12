---
"openqodex": patch
---

- The checks that look for Go and Rust no longer write into your home folder.
  - The Go check runs in a folder of its own, `~/.openqodex/cache/runtime-probe` (under `$OPENQODEX_HOME` when you set it), and Go writes no telemetry files for it.
  - The Rust check does not run a rustup command that has no toolchain installed behind it. It reports Rust as missing and says why.
- A Go, Rust or Ruby you keep in your home folder is still found, including one behind a version manager such as asdf or rbenv.
- A library host's server review runs these checks inside its own work folder.
