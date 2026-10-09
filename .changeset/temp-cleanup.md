---
"openqodex": patch
---

- A scanner install now always runs as the openqodex program of the installed package, found from the package itself, with its hidden install command; never as whatever script loaded the installer, and no caller can name another program. Before, a script that imported the scanner installer started itself again as its install process, and each copy did the same, without end. An install process now never starts another one, and the install step stops with one line when any other program runs it.
- The test suite now removes every temp folder it makes, after stopping only the background processes its own tests started, and a test run fails when a folder is left behind. Before, each init test left a copy of the openqodex runtime, about 9 MB, in the system temp folder.
- A semgrep scan no longer leaves its three rule-pack files, about 2.7 MB, in the system temp folder each time it runs. Semgrep now gets a temp folder of its own, removed after the scan.
