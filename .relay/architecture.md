# Architecture

## Layout

- `bin/relay.js` — CLI entry
- `backend/relay.js` — sync, watch, connect, register
- `backend/server.js` — Express API (:3001)
- `backend/lib/relayServe.js` — foreground/background serve orchestration
- `backend/lib/relayUi.js` — spawns Next.js Mission Control (:6374)
- `backend/lib/relayMeta.js` — `.relay/mission_control.json` (collaborators, chat)
- `mission-control/` — Next.js dashboard (Relay brain panel, agent chat, activity)
- `~/.relay-os/projects.json` — project registry + API keys

## Boundaries

- Sync/compile: Relay CLI (`watch`, stop hooks)
- IR markdown updates: session agent (or `/relay update`)
- Handoff: `relay context` → `relay_context.md`
- Mission Control reads API; does not execute coding agents
