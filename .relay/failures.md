# Failures & Anti-patterns

<!-- What failed or what NOT to repeat -->

- Duplicate `uiPort` declaration in `server.js` crashed API start — fixed; smoke-test after serve changes
- Background `relay serve` test interrupted in terminal — not a code bug; use health check on port
- Mission Control IR empty when API offline — UI now shows explicit “run relay serve / relay init” hint
- Do not expect Cursor/Copilot/Antigravity agents to run from Mission Control browser — IDE/CLI required
- `relay mcp` cwd is backend unless `RELAY_WORKSPACE_PATH` is set — document in MCP config
