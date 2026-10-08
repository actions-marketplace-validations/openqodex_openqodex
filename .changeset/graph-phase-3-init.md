---
"openqodex": minor
---

- `init` registers the code graph's MCP server, named `openqodex`, with each agent it installs into: in `~/.claude.json` for Claude Code, `~/.cursor/mcp.json` for Cursor, a marked block in `~/.codex/config.toml` for Codex, and the Cline CLI's settings file. With `--project` it writes `.mcp.json`, `.cursor/mcp.json` and `.codex/config.toml` in the repository with the pinned `npx` command. Every other server and setting in those files stays, and `init --uninstall` removes only the entry it added.
- `init --no-mcp` leaves the MCP server out and removes the registrations an earlier `init` made; a later `init` keeps that choice until `init --mcp`.
- In user scope, Claude Code may now run `<launcher> graph` with any arguments and use every tool of the `openqodex` MCP server without asking. Run `init` once after updating to get these rules and the MCP server.
