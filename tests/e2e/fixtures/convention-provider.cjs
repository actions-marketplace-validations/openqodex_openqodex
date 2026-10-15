// Model provider only. The CLI, git, snapshots and checks are real.
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const brief = JSON.parse(line).message.content;
  const id = /`change_id`: `([0-9a-f]{12})`/.exec(brief)[1];
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "conventions", tools: ["Read", "Grep", "Glob"], mcp_servers: [] }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "conventions", result: JSON.stringify({ version: 2, change_id: id, summary: "Changes the page size.", findings: [], dropped: [] }), num_turns: 1 }));
});
