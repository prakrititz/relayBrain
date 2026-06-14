# Decisions

## Open
- [ ] Whether to auto-open browser on `relay init` (currently prints URLs only)

## Resolved

- 2026-06-14 — Mission Control is **local-only**; removed NextAuth, MongoDB, GitHub OAuth, team group chat
- 2026-06-14 — `relay init` starts Mission Control + API in **background**; `--no-serve` to skip
- 2026-06-14 — `relay watch` = sync + compile only; `relay refresh` adds `relay context`
- 2026-06-14 — Mission Control **Agent chat** = team notes + launch hints, not embedded IDE agents
- 2026-06-14 — Collaborators + chat stored in `.relay/mission_control.json`
- 2026-06-14 — IR files surfaced in sidebar **Relay brain** panel + **All IR files** tab
- 2026-06-14 — npm package ships mission-control; postinstall installs UI deps
- 2026-06-14 — Optional MCP documented per agent; always set `RELAY_WORKSPACE_PATH`
- 2026-06-14 — No MongoDB/Redis; optional system `sqlite3` CLI only (not npm)
