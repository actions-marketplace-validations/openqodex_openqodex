---
"openqodex": patch
---

- A new docs page for AI agents: how to install OpenQodex, configure a repository, add a custom scanner and act on each message. `openqodex guide for-agents` prints it offline.
- The skill, the Cursor and Cline rules for a project and the team section in `CLAUDE.md` and `AGENTS.md` no longer tell an agent to allow ten minutes for a review. They say the reviewer stops after 30 minutes, and tell the agent to run the review in the background and wait until it exits.
- The skill now names the four scanners that use the network and that `--offline` skips: semgrep, osv-scanner, kubeconform and cargo-deny. It named two.
- The README is shorter and says what a compatible custom scanner needs: SARIF or one JSON document, and a release file, an exact npm or PyPI version, or a program on `PATH`.
